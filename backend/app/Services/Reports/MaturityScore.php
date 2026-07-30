<?php

namespace App\Services\Reports;

/**
 * Scoring shared by session and final reports, so a run and its sessions are
 * always graded on the same scale. Mirrored in worker/src/reporter/maturityScore.ts;
 * change both together.
 *
 * UX score answers "how clean are the screens we saw"; maturity is that same
 * score minus what the product is still missing against its competitors.
 */
class MaturityScore
{
    private const WEIGHTS = [
        'critical'   => 5.0,
        'high'       => 3.0,
        'medium'     => 1.5,
        'low'        => 0.5,
        'suggestion' => 0.1,
    ];

    /** A "validate first" gap is an unconfirmed guess, so it cannot cost as much as a confirmed one. */
    private const VALIDATE_FIRST_FACTOR = 0.25;

    /** Missing features alone must not sink an otherwise clean product to zero. */
    private const MAX_GAP_PENALTY = 40.0;

    /**
     * Severity points a scope may accumulate before it scores zero. Scaling by
     * screens is what keeps a long run from scoring worse than a short one just
     * for having looked at more.
     */
    public static function budget(int $screens): float
    {
        return max(1, $screens) * 5.0;
    }

    /** @param array<string, int|string> $severityCount */
    public static function severityPenalty(array $severityCount): float
    {
        $penalty = 0.0;
        foreach ($severityCount as $severity => $count) {
            $penalty += (self::WEIGHTS[strtolower((string) $severity)] ?? 0.0) * (int) $count;
        }
        return $penalty;
    }

    /** @param array<string, int|string> $severityCount */
    public static function ux(array $severityCount, int $screens): float
    {
        return self::clamp(100.0 - self::severityPenalty($severityCount) * 100.0 / self::budget($screens));
    }

    /**
     * Null when the scope observed nothing: scoring it 100 (no findings) or 0
     * (no evidence) would both claim more than the run actually knows.
     *
     * @param array<string, int|string>          $severityCount UX issues of this scope, keyed by severity.
     * @param list<array<string, mixed>>         $gaps          Feature gap rows of this scope, observed ones included.
     */
    public static function forScope(array $severityCount, array $gaps, int $screens): ?float
    {
        if ($screens < 1) {
            return null;
        }
        $budget     = self::budget($screens);
        $uxPenalty  = self::severityPenalty($severityCount) * 100.0 / $budget;
        $gapPenalty = min(self::MAX_GAP_PENALTY, self::gapPenalty($gaps) * 100.0 / $budget);

        return self::clamp(100.0 - $uxPenalty - $gapPenalty);
    }

    /** @param list<array<string, mixed>> $gaps */
    private static function gapPenalty(array $gaps): float
    {
        $weight = 0.0;
        foreach ($gaps as $gap) {
            if (self::isObserved($gap['observed'] ?? false)) {
                continue;
            }
            $severity = self::WEIGHTS[strtolower((string) ($gap['severity'] ?? ''))] ?? self::WEIGHTS['medium'];
            $weight += ((string) ($gap['mode'] ?? '')) === 'validate_first'
                ? $severity * self::VALIDATE_FIRST_FACTOR
                : $severity;
        }
        return $weight;
    }

    /** Postgres hands booleans back as 't'/'f' strings through some drivers. */
    private static function isObserved(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        return in_array(strtolower(trim((string) $value)), ['1', 't', 'true', 'y', 'yes'], true);
    }

    /** Reports are read by people, so an unscored scope says so instead of showing a bare zero. */
    public static function label(?float $score): string
    {
        return $score === null ? 'Not scored (no screens observed)' : $score . '/100';
    }

    private static function clamp(float $score): float
    {
        return round(max(0.0, min(100.0, $score)), 2);
    }
}
