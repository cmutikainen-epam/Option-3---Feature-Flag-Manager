import { useEffect, useState } from "react";
import { Cause, Effect, Exit } from "effect";
import { useFeatureFlags, type FeatureFlags } from "./useFeatureFlags";
import { changeJournalMode, getJournalMode, getFlagByName, getFlagByNameThrottledSequence, setFlagEnabled } from "./api";
import type { FeatureFlag } from "../shared/types";

type SelectedName = string | undefined;
type FlagError = string | undefined;

// Native <option> elements ignore CSS truncation once the dropdown is open,
// so the popup grows to fit the widest label unless the label itself is
// short. Truncate the visible text; `value`/`title` keep the full name.
const MAX_OPTION_LABEL = 80;
const truncateLabel = (name: string): string =>
  name.length > MAX_OPTION_LABEL ? `${name.slice(0, MAX_OPTION_LABEL - 1)}…` : name;

function SelectedFlagMessage({ flag }: { flag: FeatureFlag | undefined }) {
  const placeholder = "...";
  let enabled: string = placeholder;
  let enabledColour: string = placeholder;
  let created: string | undefined;
  if (flag) {
    enabled = flag.enabled ? "enabled" : "disabled";
    enabledColour = flag.enabled ? "response-enabled" : "response-disabled";
    created = new Date(flag.createdAt).toLocaleString();
  }

  return (
    <span>
      is <strong className={enabledColour}>{enabled}</strong>
      <br />
      added on <span className="blue">{created ?? placeholder}</span>
      <br />
      MVCC version is <span className="blue">{flag?.version ?? placeholder}</span>
    </span>
  );
}

function FlagSelect({
  flags,
  flagError,
  selectedName,
  onChange,
}: {
  flags: FeatureFlags;
  flagError: FlagError;
  selectedName: SelectedName;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
}) {
  const selector = (
    <>
      <select id="flagSelect" value={selectedName} onChange={onChange}>
        <option value="">Select a flag…</option>
        {flags.map((flag) => (
          <option key={flag.id} value={flag.name} title={flag.name}>
            {truncateLabel(flag.name)}
          </option>
        ))}
      </select>
    </>
  );

  return (
    <>
      {selector}
      <p className="response">
        {flagError ?? (
          <SelectedFlagMessage flag={flags.find(({ name }) => name === selectedName)} />
        )}
      </p>
    </>
  );
}

function ThrottledToggle({
  flags,
  selectedName,
}: {
  flags: FeatureFlags;
  selectedName: SelectedName;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FlagError>(undefined);
  const selectedFlag = flags.find((f) => f.name === selectedName);

  const handleToggleThrottled = () => {
    const flag = selectedFlag;
    if (!flag) return;
    setLoading(true);
    setError(undefined);
    Effect.runPromiseExit(setFlagEnabled(flag.id, !flag.enabled, flag.version, true)).then(
      (exit) => {
        setLoading(false);
        if (Exit.isFailure(exit)) {
          setError(Cause.pretty(exit.cause));
        }
      },
    );
  };

  return (
    <div className="test-section">
      <h3>Throttled Toggle</h3>
      <p className="section-note">
        Toggle a flag with a 10s delay before responding via WebSocket. In another tab, try to
        toggle the same flag and see the error.{" "}
      </p>
      <button
        onClick={handleToggleThrottled}
        disabled={!selectedFlag || loading}
        className="throttled-button"
      >
        {loading ? "Toggling…" : "Toggle (10s delay)"}
      </button>
      {error && <p className="response">{error}</p>}
    </div>
  );
}

function ToggleJournalMode({ loadingFirst, loadingSecond}: { loadingFirst: boolean; loadingSecond: boolean; }) {
  const [journalLoading, setJournalLoading] = useState<boolean>(true)
  const [journalMode, setJournalMode] = useState<string | undefined>(undefined)

  useEffect(() => {
    Effect.runPromiseExit(getJournalMode()).then((exit) => {
      if (Exit.isSuccess(exit)) {
        setJournalMode(exit.value)
      } else {
        setJournalMode(Cause.pretty(exit.cause))
      }
    })

    setTimeout(() => setJournalLoading(false), 500)
  }, [])

  return <button
    onClick={() => {
      setJournalLoading(true)
      Effect.runPromiseExit(changeJournalMode(journalMode === 'wal' ? "delete" : "wal")).then((exit) => {
        if (Exit.isSuccess(exit)) {
          setJournalMode(exit.value)
        } else {
          setJournalMode(Cause.pretty(exit.cause))
        }
        setJournalLoading(false)
      })
    }}
    disabled={loadingFirst || loadingSecond}
    className="throttled-button throttled-button-blue"
  >
    Journal Mode Toggle: {journalLoading
      ? "Running…"
      : `${journalMode?.toUpperCase()}`}
  </button>
}

function ReadSequenceDemo({
  flags,
  selectedName,
}: {
  flags: FeatureFlags;
  selectedName: SelectedName;
}) {
  const [loadingFirst, setLoadingFirst] = useState(false);
  const [loadingSecond, setLoadingSecond] = useState(false);
  const [firstRead, setFirstRead] = useState<string | undefined>(undefined);
  const [secondRead, setSecondRead] = useState<string | undefined>(undefined);
  const selectedFlag = flags.find((f) => f.name === selectedName);

  const handleRun = async (selectedName: string) => {
    if (!selectedFlag) return;
    setLoadingFirst(true);
    setFirstRead(undefined);
    setSecondRead(undefined);

    Effect.runPromiseExit(getFlagByNameThrottledSequence(selectedName))

    await Effect.runPromiseExit(getFlagByName(selectedName)).then((exit) => {
      setLoadingFirst(false);
      if (Exit.isFailure(exit)) {
        setFirstRead(Cause.pretty(exit.cause));
        return;
      }
      setFirstRead(exit.value ? "enabled" : "disabled");
    });

    setLoadingSecond(true);

    await new Promise(resolve => setTimeout(resolve, 10_000))

    Effect.runPromiseExit(getFlagByName(selectedName)).then((secondExit) => {
      setLoadingSecond(false);
      if (Exit.isSuccess(secondExit)) {
        setSecondRead(secondExit.value ? "enabled" : "disabled");
      } else {
        setSecondRead(Cause.pretty(secondExit.cause));
      }
    });
  };

  return (
    <div className="test-section">
      <h3>WAL (Write-ahead log) Demo Sequence</h3>
      <div className="section-note">
        <ol>
          <li>Click button to trigger an explicit transaction on a new connection</li>
          <li>The current value is rendered as #1</li>
          <li>While the transaction is open, initiate a write on the same flag using another client (e.g new browser tab)</li>
          <li>In DELETE mode, the write will be blocked and we will see the original value rendered as #2 once the throttled transaction is commited</li>
          <li>In WAL mode, the write will not be blocked, and we will see the second read renders the updated value as #2</li>
          <li>Click the Journal Mode Toggle to switch modes</li>
        </ol>
      </div>
      <button
        onClick={() => selectedName && handleRun(selectedName)}
        disabled={!selectedFlag || loadingFirst || loadingSecond}
        className="throttled-button"
      >
        {loadingFirst || loadingSecond
          ? "Running…"
          : "Run read sequence (10s Delay betweeen reads)"}
      </button>
      <ol className="read-sequence-results">
        <li>
          {loadingFirst && (
            <p className="section-note">Initializing: …</p>
          )}
          {firstRead !== undefined && (
            <p className="section-note">First read before COMMIT: {firstRead}</p>
          )}
        </li>
        <li>
          {loadingSecond && (
            <p className="section-note">Waiting for throttled transaction to complete: …</p>
          )}
          {secondRead !== undefined && (
            <p className="section-note">Second read after COMMIT: {secondRead}</p>
          )}
        </li>
      </ol>
      <ToggleJournalMode loadingFirst={loadingFirst} loadingSecond={loadingSecond}/>
    </div>
  );
}

export default function Test() {
  const { flags, error: flagError } = useFeatureFlags();
  const [selectedName, setSelectedName] = useState<SelectedName>();

  // flags arrives live over the WebSocket; if the selected flag was deleted
  // elsewhere, drop the selection so the picker doesn't hold a ghost value.
  const effectiveSelectedName =
    selectedName && flags.some((flag) => flag.name === selectedName) ? selectedName : undefined;

  return (
    <div className="test-page">
      <h2>Feature Flag MVCC Playground</h2>

      <div className="test-flag-picker">
        <FlagSelect
          flags={flags}
          flagError={flagError}
          selectedName={effectiveSelectedName}
          onChange={(e: React.ChangeEvent<HTMLSelectElement, HTMLSelectElement>) =>
            setSelectedName(e.target.value.length ? e.target.value : undefined)
          }
        />
      </div>

      <ThrottledToggle flags={flags} selectedName={effectiveSelectedName} />

      <ReadSequenceDemo flags={flags} selectedName={effectiveSelectedName} />
    </div>
  );
}
