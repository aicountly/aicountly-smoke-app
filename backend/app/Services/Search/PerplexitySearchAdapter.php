<?php

namespace App\Services\Search;

use App\Services\Brain\Adapters\PerplexityAdapter;

/**
 * Thin facade over the Perplexity adapter that the FeatureGap / Competitor
 * comparison engines use as the configurable search provider. When Perplexity
 * is not configured, callers get an empty result + sources=[] and must mark
 * the comparison as "not available due to missing search configuration".
 */
class PerplexitySearchAdapter
{
    public function __construct(private ?PerplexityAdapter $perplexity = null)
    {
        $this->perplexity ??= new PerplexityAdapter();
    }

    public function isAvailable(): bool
    {
        return $this->perplexity?->isConfigured() ?? false;
    }

    /**
     * @return array{summary:string,sources:array<int,array<string,mixed>>,available:bool}
     */
    public function research(string $query): array
    {
        if (! $this->isAvailable()) {
            return [
                'available' => false,
                'summary'   => 'External search not configured (no PERPLEXITY_API_KEY).',
                'sources'   => [],
            ];
        }
        $r = $this->perplexity->search($query);
        return ['available' => true] + $r;
    }
}
