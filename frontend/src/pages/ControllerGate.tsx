import type { GateReason } from '@/hooks/useAuthBootstrap';
import {
  GATE_CONSOLE_REQUIRED,
  GATE_ERROR,
  GATE_NO_ACCESS,
} from '@/hooks/useAuthBootstrap';
import { consoleLoginUrl } from '@/lib/consoleAuth';

const APP_NAME = import.meta.env.VITE_APP_NAME || 'AICOUNTLY Smoke Portal';

type Props = {
  gateReason: GateReason;
  gateMessage: string;
  retryAuth: () => Promise<void>;
  ssoPending: boolean;
};

export function ControllerGate({ gateReason, gateMessage, retryAuth, ssoPending }: Props) {
  const reason = gateReason || GATE_CONSOLE_REQUIRED;
  const isPending = ssoPending;

  return (
    <div className="min-h-screen grid place-items-center bg-gradient-to-br from-brand-50 via-white to-ink-50 p-6">
      <div className="card p-8 w-full max-w-md">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-brand-500 grid place-items-center text-white text-lg font-semibold">S</div>
          <div>
            <div className="text-lg font-semibold">{APP_NAME}</div>
            <div className="text-xs text-ink-500">smoke.aicountly.org · Console identity only</div>
          </div>
        </div>

        {isPending ? (
          <>
            <h1 className="text-lg font-semibold text-ink-900">Signing you in…</h1>
            <p className="mt-2 text-sm text-ink-600">Checking your Console session and controller access.</p>
          </>
        ) : reason === GATE_NO_ACCESS ? (
          <>
            <h1 className="text-lg font-semibold text-amber-800">Access not assigned</h1>
            <p className="mt-2 text-sm text-ink-600">
              You are signed in to Console, but this account does not have access to the Smoke controller app.
            </p>
            {gateMessage ? (
              <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{gateMessage}</div>
            ) : null}
            <p className="mt-3 text-xs text-ink-500">
              Ask a Console administrator to grant Smoke access under Controller App Access, then click Retry.
            </p>
          </>
        ) : reason === GATE_ERROR ? (
          <>
            <h1 className="text-lg font-semibold text-danger">Sign-in failed</h1>
            <p className="mt-2 text-sm text-ink-600">
              {gateMessage || 'Could not complete Console sign-in for Smoke Portal.'}
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-ink-900">Sign in via Console</h1>
            <p className="mt-2 text-sm text-ink-600">
              This portal does not use a local email/password login. Sign in at{' '}
              <strong>console.aicountly.org</strong>, then open Smoke from Top Controller Apps or return here.
            </p>
            {gateMessage && gateMessage !== 'Sign in to Console first.' ? (
              <div className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-700">{gateMessage}</div>
            ) : null}
          </>
        )}

        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          {reason === GATE_CONSOLE_REQUIRED ? (
            <a href={consoleLoginUrl()} className="btn-primary justify-center text-center">
              Open Console sign-in
            </a>
          ) : null}
          <button
            type="button"
            className="btn-secondary justify-center"
            onClick={() => void retryAuth()}
            disabled={isPending}
          >
            {isPending ? 'Checking…' : 'Retry'}
          </button>
        </div>

        <p className="text-[11px] text-ink-500 mt-6 text-center">
          Product intelligence portal · observer mode only
        </p>
      </div>
    </div>
  );
}
