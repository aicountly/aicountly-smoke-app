<?php

namespace App\Services\Reports;

/**
 * Wraps the per-finding Cursor prompts already stored in developer_prompt columns
 * into one run-level "master prompt": a verify-before-implement operating
 * contract (prefix), findings grouped by how much this pass trusts its own
 * detection, a per-finding "how was this detected / how to disprove it" note,
 * and a report-back contract (suffix).
 *
 * Mirrored in worker/src/reporter/cursorHandoff.ts, which assembles the same
 * document from typed UxIssue/FeatureGap objects at scan time. This class works
 * from raw DB rows because the rebuild path here never re-runs the browser scan
 * -- change the shared prose in samples/prompts/ and the grouping rules in both
 * places together.
 *
 * A "finding" is an associative array with either:
 *   - UX issue shape: category, severity, title, developer_prompt, evidence (decoded array)
 *   - Feature gap shape: expected_feature, mode, partial, observed, severity,
 *     developer_prompt, evidence (decoded array) -- presence of 'expected_feature'
 *     is what distinguishes a gap from a UX issue.
 */
class CursorHandoff
{
    private const GROUP_ORDER = ['verify_then_fix', 'likely_artifact', 'do_not_build'];

    private const GROUP_TITLE = [
        'verify_then_fix'  => 'Group A — Verify then fix',
        'likely_artifact'  => 'Group B — Likely detector artifact',
        'do_not_build'     => 'Group C — Do not build (validate first)',
    ];

    private const GROUP_COUNT_LABEL = [
        'verify_then_fix'  => 'to verify then fix',
        'likely_artifact'  => 'likely detector artifacts',
        'do_not_build'     => 'backlog questions, not build orders',
    ];

    private const SEVERITY_RANK = [
        'critical' => 4, 'high' => 3, 'medium' => 2, 'low' => 1, 'suggestion' => 0,
    ];

    /** Matches a topbar company/branch/financial-year switcher by label text alone, independent of DOM kind. */
    private const SELECTOR_LABEL_PATTERN = '/\b(fy|company|branch|ho)\b|20\d{2}\s*[-–]\s*\d{2,4}/i';

    /** Matches a search/command-palette trigger by label text alone, independent of DOM kind. */
    private const SEARCH_LABEL_PATTERN = '/search|\bcmd\s*\+?\s*k\b|\bctrl\s*\+?\s*k\b/i';

    /** Matches repeated CRUD / row-action labels that should not become rename-visible-copy build orders. */
    private const ROW_ACTION_LABEL_PATTERN = '/^(edit|delete|deactivate|activate|view|all|remove|approve|reject)$/i';

    /** Matches tabular export / Download CSV|Excel|PDF labels used as export evidence. */
    private const EXPORT_OR_DOWNLOAD_LABEL_PATTERN = '/download\b.*\b(csv|excel|xlsx|xls|pdf)|\bexport\b/i';

    private const FALLBACK_PREFIX = "# Master Cursor prompt: {{run_code}}\n\n"
        . "Every finding below is a machine-generated hypothesis, not a work order.\n"
        . "Locate the owning code, verify each finding against it, and implement only\n"
        . "what you confirm is a real defect. Never modify the smoke-testing application.";

    private const FALLBACK_SUFFIX = "## Report back\n\n"
        . "List each finding's verdict (confirmed, already implemented, mis-scoped, or\n"
        . "needs a product decision) with file evidence before opening a pull request.";

    private const FALLBACK_CAVEAT = [
        'detected_by' => "A generic heuristic check specific to this finding's category.",
        'blind_spot'  => 'Heuristic DOM/text checks cannot see every valid implementation of a capability.',
        'disprove'    => "Verify directly against the live screen and this repository's code before implementing anything.",
    ];

    /** @var array{caveats: list<array<string, mixed>>, fallback: array{detected_by: string, blind_spot: string, disprove: string}}|null */
    private static ?array $catalog = null;

    private static ?string $prefixTemplate = null;

    private static ?string $suffixTemplate = null;

    /** The sentinel a downstream loader can grep for to know a file was built by this class, rather than the legacy joiner. */
    public const SENTINEL = '<!-- smoke:master-prompt v1 -->';

    /** @param array{run_code: string, product_name: string, environment: string, repos: list<string>, counts?: string, generated_at?: string} $context */
    public static function renderPrefix(array $context): string
    {
        $template = self::$prefixTemplate ??= self::readSample('cursor-master-prefix.md') ?? self::FALLBACK_PREFIX;
        $repos = $context['repos'] ?? [];
        return trim(self::fillTemplate($template, [
            'run_code'     => (string) ($context['run_code'] ?? ''),
            'product_name' => (string) ($context['product_name'] ?? ''),
            'environment'  => (string) ($context['environment'] ?? ''),
            'repos'        => $repos !== [] ? implode(', ', $repos) : 'not resolved from the observed URLs',
            'counts'       => (string) ($context['counts'] ?? ''),
            'generated_at' => (string) ($context['generated_at'] ?? date(DATE_ATOM)),
        ]));
    }

    public static function renderSuffix(): string
    {
        return trim(self::$suffixTemplate ??= self::readSample('cursor-master-suffix.md') ?? self::FALLBACK_SUFFIX);
    }

    /**
     * @param array<string, mixed>              $finding             evidence key holds a decoded array
     * @param list<string>                      $allInventoryLabels  full run/session inventory labels, independent of this finding's own narrow evidence sample
     */
    public static function classifyTrust(array $finding, array $allInventoryLabels = []): string
    {
        $labels = $allInventoryLabels !== [] ? $allInventoryLabels : self::ownInventoryLabels($finding);

        if (self::isFeatureGap($finding)) {
            if (($finding['mode'] ?? '') === 'validate_first') {
                return 'do_not_build';
            }
            $matched = self::stringList($finding['evidence']['matched_context'] ?? []);
            if (($finding['mode'] ?? '') === 'implement' && self::truthy($finding['partial'] ?? false) && $matched !== []) {
                return 'likely_artifact';
            }
            return 'verify_then_fix';
        }

        if (($finding['category'] ?? '') === 'multi_tenant' && self::anyLabelMatches($labels, self::SELECTOR_LABEL_PATTERN)) {
            return 'likely_artifact';
        }
        if (
            ($finding['category'] ?? '') === 'navigation'
            && preg_match('/search|command/i', (string) ($finding['title'] ?? '')) === 1
            && self::anyLabelMatches($labels, self::SEARCH_LABEL_PATTERN)
        ) {
            return 'likely_artifact';
        }
        if (($finding['category'] ?? '') === 'filters') {
            $evidence = is_array($finding['evidence'] ?? null) ? $finding['evidence'] : [];
            $samples = $evidence['inventory_samples'] ?? [];
            $hasSearchOrFilterKind = false;
            if (is_array($samples)) {
                foreach ($samples as $item) {
                    if (! is_array($item)) {
                        continue;
                    }
                    $kind = (string) ($item['kind'] ?? '');
                    if ($kind === 'search' || $kind === 'filter') {
                        $hasSearchOrFilterKind = true;
                        break;
                    }
                }
            }
            if ($hasSearchOrFilterKind || self::anyLabelMatches($labels, self::SEARCH_LABEL_PATTERN)) {
                return 'likely_artifact';
            }
        }
        // "Download CSV/Excel/PDF" is export evidence; demote leftover export findings.
        if (
            ($finding['category'] ?? '') === 'reports'
            && preg_match('/export/i', (string) ($finding['title'] ?? '')) === 1
            && self::anyLabelMatches($labels, self::EXPORT_OR_DOWNLOAD_LABEL_PATTERN)
        ) {
            return 'likely_artifact';
        }
        // Repeated CRUD row actions already emit accessible-name recommendations
        // at the scanner/reviewer layer; demote high-count duplicates so prompt
        // packs do not promote them as build orders (Group B, not Group A).
        if (
            ($finding['category'] ?? '') === 'layout'
            && preg_match('/duplicate button label/i', (string) ($finding['title'] ?? '')) === 1
        ) {
            $title = (string) ($finding['title'] ?? '');
            $titleLabel = '';
            if (preg_match('/\bduplicate button label\s+"([^"]+)"/i', $title, $m) === 1) {
                $titleLabel = (string) ($m[1] ?? '');
            }
            $evidence = is_array($finding['evidence'] ?? null) ? $finding['evidence'] : [];
            $count = is_numeric($evidence['count'] ?? null) ? (int) $evidence['count'] : 0;
            $promptBlob = (string) ($finding['recommendation'] ?? '') . ' ' . (string) ($finding['developer_prompt'] ?? '');
            $accessibleNameStyle = preg_match('/accessible name|aria-label/i', $promptBlob) === 1;
            if (
                $count > 2
                && $accessibleNameStyle
                && preg_match(self::ROW_ACTION_LABEL_PATTERN, $titleLabel) === 1
            ) {
                return 'likely_artifact';
            }
        }
        return 'verify_then_fix';
    }

    /** @param array<string, mixed> $finding */
    public static function caveatFor(array $finding): array
    {
        $catalog = self::loadCatalog();
        if (self::isFeatureGap($finding)) {
            foreach ($catalog['caveats'] as $caveat) {
                if (($caveat['category'] ?? '') === 'feature_gap' && ($caveat['mode'] ?? '') === ($finding['mode'] ?? '')) {
                    return self::caveatText($caveat);
                }
            }
            return $catalog['fallback'];
        }
        $title = (string) ($finding['title'] ?? '');
        $candidates = array_values(array_filter(
            $catalog['caveats'],
            static fn (array $c): bool => ($c['category'] ?? '') === ($finding['category'] ?? ''),
        ));
        foreach ($candidates as $caveat) {
            if (! empty($caveat['title_pattern']) && preg_match('/' . $caveat['title_pattern'] . '/i', $title) === 1) {
                return self::caveatText($caveat);
            }
        }
        foreach ($candidates as $caveat) {
            if (empty($caveat['title_pattern'])) {
                return self::caveatText($caveat);
            }
        }
        return $catalog['fallback'];
    }

    /**
     * Reads back the "- Repository:" lines the worker already wrote into each
     * developer_prompt (via repoAttribution.ts), so this PHP path -- which never
     * resolves URLs to repos itself -- states the same ownership.
     *
     * @param list<string> $developerPrompts
     * @return list<string>
     */
    public static function reposFromPrompts(array $developerPrompts): array
    {
        $repos = [];
        foreach ($developerPrompts as $prompt) {
            if (preg_match_all('/^\s*-\s*Repository:\s*(\S.*?)\s*$/m', (string) $prompt, $matches) > 0) {
                foreach ($matches[1] as $repo) {
                    $repos[$repo] = true;
                }
            }
        }
        $names = array_keys($repos);
        sort($names);
        return $names;
    }

    /**
     * @param array{run_code: string, product_name: string, environment: string, generated_at?: string} $context
     * @param list<array<string, mixed>> $uxRows   each with evidence already decoded to an array
     * @param list<array<string, mixed>> $gapRows  each with evidence already decoded to an array
     * @param list<string>               $allInventoryLabels
     */
    public static function assembleMasterPrompt(array $context, array $uxRows, array $gapRows, array $allInventoryLabels = []): string
    {
        $entries = [];
        foreach (array_merge($uxRows, $gapRows) as $finding) {
            $prompt = self::withDetectionBlock($finding);
            if (trim($prompt) === '') {
                continue;
            }
            $entries[] = [
                'finding' => $finding,
                'prompt'  => $prompt,
                'group'   => self::classifyTrust($finding, $allInventoryLabels),
            ];
        }

        $byGroup = static function (string $group) use ($entries): array {
            $rows = array_values(array_filter($entries, static fn (array $e): bool => $e['group'] === $group));
            usort($rows, static fn (array $a, array $b): int => self::rank($b['finding']) <=> self::rank($a['finding']));
            return $rows;
        };

        $countParts = [];
        foreach (self::GROUP_ORDER as $group) {
            $countParts[] = count($byGroup($group)) . ' ' . self::GROUP_COUNT_LABEL[$group];
        }

        $prefix = self::renderPrefix($context + [
            'repos'  => self::reposFromPrompts(array_column($entries, 'prompt')),
            'counts' => $entries !== [] ? 'Findings: ' . implode(', ', $countParts) . '.' : 'No findings recorded in this pack.',
        ]);

        $sections = [];
        foreach (self::GROUP_ORDER as $group) {
            $rows = $byGroup($group);
            if ($rows === []) {
                continue;
            }
            $sections[] = '# ' . self::GROUP_TITLE[$group];
            foreach ($rows as $row) {
                $sections[] = $row['prompt'];
            }
        }

        return implode("\n\n---\n\n", array_merge([self::SENTINEL, $prefix], $sections, [self::renderSuffix()]));
    }

    /** @param array<string, mixed> $finding */
    private static function isFeatureGap(array $finding): bool
    {
        return array_key_exists('expected_feature', $finding);
    }

    /** @param array<string, mixed> $finding */
    private static function ownInventoryLabels(array $finding): array
    {
        $evidence = is_array($finding['evidence'] ?? null) ? $finding['evidence'] : [];
        $samples = $evidence['inventory_samples'] ?? $evidence['nearby_inventory'] ?? [];
        if (! is_array($samples)) {
            return [];
        }
        $labels = [];
        foreach ($samples as $item) {
            if (is_array($item) && isset($item['label'])) {
                $labels[] = (string) $item['label'];
            }
        }
        return array_values(array_filter($labels, static fn (string $l): bool => $l !== ''));
    }

    /** @param list<string> $labels */
    private static function anyLabelMatches(array $labels, string $pattern): bool
    {
        foreach ($labels as $label) {
            if (preg_match($pattern, $label) === 1) {
                return true;
            }
        }
        return false;
    }

    /**
     * Names the tokens the feature-gap detector actually matched versus the ones
     * it never found anywhere in the run, when that gap is a partial/implement
     * match -- the shape behind false positives like "employee directory"
     * (matched "employee", never found "directory").
     *
     * @param array<string, mixed> $gap
     */
    private static function describeMatchedTokens(array $gap): ?string
    {
        $matched = self::stringList($gap['evidence']['matched_context'] ?? []);
        if ($matched === []) {
            return null;
        }
        $tokens = array_values(array_filter(preg_split('/\s+/', strtolower((string) ($gap['expected_feature'] ?? ''))) ?: []));
        $missing = array_values(array_diff($tokens, $matched));
        if ($missing === []) {
            return null;
        }
        $wrap = static fn (string $t): string => '`' . $t . '`';
        return 'Matched: ' . implode(', ', array_map($wrap, $matched)) . '. Never found: ' . implode(', ', array_map($wrap, $missing)) . '.';
    }

    /** @param array<string, mixed> $finding */
    private static function detectionBlock(array $finding): string
    {
        $caveat = self::caveatFor($finding);
        $lines = [
            '## Detection & disproof',
            '- Detected by: ' . $caveat['detected_by'],
            '- Blind spot: ' . $caveat['blind_spot'],
        ];
        if (self::isFeatureGap($finding)) {
            $evidence = self::describeMatchedTokens($finding);
            if ($evidence !== null) {
                $lines[] = "- This run's own evidence: " . $evidence;
            }
        }
        $lines[] = '- To disprove: ' . $caveat['disprove'];
        return implode("\n", $lines);
    }

    /** @param array<string, mixed> $finding */
    private static function withDetectionBlock(array $finding): string
    {
        $body = trim((string) ($finding['developer_prompt'] ?? ''));
        if ($body === '') {
            return '';
        }
        return $body . "\n\n" . self::detectionBlock($finding);
    }

    /** @param array<string, mixed> $finding */
    private static function rank(array $finding): int
    {
        return self::SEVERITY_RANK[strtolower((string) ($finding['severity'] ?? ''))] ?? 0;
    }

    /** @return array{caveats: list<array<string, mixed>>, fallback: array{detected_by: string, blind_spot: string, disprove: string}} */
    private static function loadCatalog(): array
    {
        if (self::$catalog !== null) {
            return self::$catalog;
        }
        $raw = self::readSample('detector-caveats.json');
        if ($raw !== null) {
            $parsed = json_decode($raw, true);
            if (is_array($parsed) && is_array($parsed['caveats'] ?? null) && is_array($parsed['fallback'] ?? null)) {
                return self::$catalog = ['caveats' => $parsed['caveats'], 'fallback' => self::caveatText($parsed['fallback'])];
            }
        }
        return self::$catalog = ['caveats' => [], 'fallback' => self::FALLBACK_CAVEAT];
    }

    /** @param array<string, mixed> $caveat @return array{detected_by: string, blind_spot: string, disprove: string} */
    private static function caveatText(array $caveat): array
    {
        return [
            'detected_by' => (string) ($caveat['detected_by'] ?? self::FALLBACK_CAVEAT['detected_by']),
            'blind_spot'  => (string) ($caveat['blind_spot'] ?? self::FALLBACK_CAVEAT['blind_spot']),
            'disprove'    => (string) ($caveat['disprove'] ?? self::FALLBACK_CAVEAT['disprove']),
        ];
    }

    private static function readSample(string $file): ?string
    {
        foreach ([
            realpath(WRITEPATH . '../../samples/prompts/' . $file),
            realpath(WRITEPATH . '../../../samples/prompts/' . $file),
        ] as $path) {
            if ($path !== false && is_file($path)) {
                return (string) file_get_contents($path);
            }
        }
        return null;
    }

    /** @param array<string, string> $vars */
    private static function fillTemplate(string $template, array $vars): string
    {
        return (string) preg_replace_callback(
            '/\{\{(\w+)\}\}/',
            static fn (array $m): string => $vars[$m[1]] ?? '',
            $template,
        );
    }

    private static function stringList(mixed $value): array
    {
        $values = is_array($value) ? $value : ($value === null || $value === '' ? [] : [$value]);
        return array_values(array_unique(array_filter(array_map(
            static fn ($item): string => is_scalar($item) ? strtolower(trim((string) $item)) : '',
            $values,
        ))));
    }

    private static function truthy(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        return in_array(strtolower(trim((string) $value)), ['1', 't', 'true', 'y', 'yes'], true);
    }
}
