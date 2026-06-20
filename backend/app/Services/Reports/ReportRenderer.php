<?php

namespace App\Services\Reports;

/**
 * Tiny mustache-flavoured renderer for our report HTML templates. Supports
 * {{var}}, {{#section}}...{{/section}} and {{^section}}...{{/section}}. Good
 * enough for our stable report layouts and no extra dependency required.
 */
class ReportRenderer
{
    public function render(string $template, array $vars): string
    {
        $vars = $vars ?? [];
        // sections (positive)
        $template = preg_replace_callback(
            '/\{\{#([A-Za-z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/',
            function ($m) use ($vars) {
                $val = $vars[$m[1]] ?? null;
                if (! $val) return '';
                if (is_array($val) && array_is_list($val)) {
                    $out = '';
                    foreach ($val as $row) {
                        $row = is_array($row) ? $row : ['value' => $row];
                        $out .= $this->render($m[2], $row + $vars);
                    }
                    return $out;
                }
                return $this->render($m[2], (is_array($val) ? $val : []) + $vars);
            },
            $template,
        );
        // sections (negative)
        $template = preg_replace_callback(
            '/\{\{\^([A-Za-z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/',
            function ($m) use ($vars) {
                $val = $vars[$m[1]] ?? null;
                if ($val) return '';
                return $m[2];
            },
            $template,
        );
        // simple vars
        $template = preg_replace_callback(
            '/\{\{([A-Za-z0-9_\.]+)\}\}/',
            function ($m) use ($vars) {
                $val = $this->lookup($vars, $m[1]);
                return $val === null ? '' : htmlspecialchars((string) $val, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
            },
            $template,
        );
        return $template;
    }

    private function lookup(array $vars, string $path)
    {
        if (! str_contains($path, '.')) {
            return $vars[$path] ?? null;
        }
        $cur = $vars;
        foreach (explode('.', $path) as $k) {
            if (is_array($cur) && array_key_exists($k, $cur)) {
                $cur = $cur[$k];
            } else {
                return null;
            }
        }
        return is_scalar($cur) ? $cur : json_encode($cur);
    }
}
