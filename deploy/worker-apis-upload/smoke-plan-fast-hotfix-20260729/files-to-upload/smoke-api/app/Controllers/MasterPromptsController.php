<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;
use Config\Services;

class MasterPromptsController extends BaseController
{
    public function samples(): ResponseInterface
    {
        $product = trim((string) ($this->request->getGet('product_name') ?? ''));
        $grouped = Services::promptSamples()->forProduct($product !== '' ? $product : null);

        return $this->jsonOk([
            'recommended' => $grouped['recommended'],
            'other'       => $grouped['other'],
            'data'        => array_merge($grouped['recommended'], $grouped['other']),
        ]);
    }

    public function create(): ResponseInterface
    {
        // Planner may call an external LLM; avoid PHP killing the request mid-flight.
        @set_time_limit(120);

        $body = $this->jsonBody();
        $promptText = trim((string) ($body['prompt_text'] ?? ''));
        $profileId  = (int) ($body['target_profile_id'] ?? 0);
        $title      = trim((string) ($body['title'] ?? ''));
        $env        = (string) ($body['environment'] ?? '');

        if ($promptText === '' || $profileId <= 0 || $title === '' || $env === '') {
            return $this->jsonError('invalid_request', 'title, prompt_text, environment and target_profile_id are required.', 400);
        }

        $db = Database::connect();
        $profile = $db->table('smoke_target_profiles')->where('id', $profileId)->get()->getRowArray();
        if (! $profile) {
            return $this->jsonError('not_found', 'Target profile not found', 404);
        }

        // Force production safety
        if (in_array($env, ['production_readonly', 'production_restricted'], true)) {
            $body['destructive_allowed'] = false;
        }

        $userId = (int) ($this->user()?->id ?? 0);

        $db->table('smoke_master_prompts')->insert([
            'user_id'           => $userId,
            'target_profile_id' => $profileId,
            'environment'       => $env,
            'title'             => $title,
            'prompt_text'       => $promptText,
            'status'            => 'planning',
        ]);
        $masterPromptId = (int) $db->insertID();

        try {
            $plan = Services::planner()->plan($promptText, $profile, $env);
        } catch (\Throwable $e) {
            $db->table('smoke_master_prompts')->where('id', $masterPromptId)->update([
                'status'     => 'failed',
                'updated_at' => date('Y-m-d H:i:s'),
            ]);
            return $this->jsonError('planning_failed', 'Session plan generation failed: ' . $e->getMessage(), 502);
        }

        // Create the plan + sessions
        $db->table('smoke_session_plans')->insert([
            'master_prompt_id' => $masterPromptId,
            'plan_json'        => json_encode($plan),
            'rationale'        => (string) ($plan['rationale'] ?? ''),
            'session_count'    => count($plan['sessions'] ?? []),
            'status'           => 'draft',
        ]);
        $planId = (int) $db->insertID();

        foreach ((array) ($plan['sessions'] ?? []) as $idx => $s) {
            $db->table('smoke_sessions')->insert([
                'plan_id'             => $planId,
                'ordinal'             => (int) ($s['ordinal'] ?? ($idx + 1)),
                'name'                => (string) ($s['name'] ?? ('Session ' . ($idx + 1))),
                'menu_path'           => (string) ($s['menu_path'] ?? ''),
                'description'         => (string) ($s['description'] ?? ''),
                'scope_json'          => json_encode($s['scope'] ?? []),
                'allowed_actions_json'=> json_encode($s['allowed_actions'] ?? []),
                'destructive_allowed' => (bool) ($s['destructive_allowed'] ?? false),
                'expected_screens'    => (int) ($s['expected_screens'] ?? 0),
                'status'              => 'pending',
            ]);
        }

        $db->table('smoke_master_prompts')->where('id', $masterPromptId)->update([
            'parsed_objective_json' => json_encode([
                'product'      => $profile['product_name'] ?? null,
                'environment'  => $env,
                'session_count'=> count($plan['sessions'] ?? []),
            ]),
            'brain_response_json' => json_encode($plan['_brain_meta'] ?? []),
            'status'              => 'planned',
            'updated_at'          => date('Y-m-d H:i:s'),
        ]);

        Services::audit()->record('master_prompts.create', 'smoke_master_prompts', (string) $masterPromptId, $userId, [
            'target_profile_id' => $profileId,
            'environment'       => $env,
            'plan_id'           => $planId,
            'sessions'          => count($plan['sessions'] ?? []),
        ]);

        return $this->jsonOk([
            'master_prompt_id' => $masterPromptId,
            'plan_id'          => $planId,
            'plan'             => $plan,
        ], 201);
    }

    public function show(int $id): ResponseInterface
    {
        $db = Database::connect();
        $row = $db->table('smoke_master_prompts')->where('id', $id)->get()->getRowArray();
        if (! $row) {
            return $this->jsonError('not_found', 'Master prompt not found', 404);
        }
        $plan = $db->table('smoke_session_plans')->where('master_prompt_id', $id)->orderBy('id', 'DESC')->get()->getRowArray();
        return $this->jsonOk(['data' => $row, 'plan' => $plan]);
    }
}
