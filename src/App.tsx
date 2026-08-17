import { useEffect, useState } from "react";
import { useFeatureFlags } from "./useFeatureFlags";

export default function App() {
  const { flags, loading, connected, error, addFlag, toggleFlag, deleteFlag, clearError } =
    useFeatureFlags();
  const [name, setName] = useState("");

  useEffect(() => {
    if (!error) return;
    document.addEventListener("click", clearError);
    return () => document.removeEventListener("click", clearError);
  }, [error, clearError]);

  const onAdd = (event: React.SyntheticEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    addFlag(trimmed);
    setName("");
  };

  return (
    <main className="app">
      <header className="header">
        <h1>Option 3 - Feature Flag Manager </h1>
        <span className={`status ${connected ? "status--live" : "status--offline"}`} role="status">
          {connected ? "live" : "reconnecting…"}
        </span>
      </header>
      <p className="subtitle">
        Add, toggle and delete Feature Flags in the list below. Call{" "}
        <code>{"/api/flags/check?name={name}"}</code> to check if a flag is enabled or navigate to
        /test to demo concurrency features.
      </p>

      <div className="add-form-wrap">
        <form className="add-form" onSubmit={onAdd}>
          <input
            aria-label="New flag name"
            placeholder="Add a feature flag…"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit">Add</button>
        </form>

        {error && (
          <div className="error-popup">
            <p role="alert" className="error">
              {error}
            </p>
          </div>
        )}
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : flags.length === 0 ? (
        <p>No feature flags yet — add one above.</p>
      ) : (
        <ul className="flags">
          {flags.map((flag) => (
            <li key={flag.id} className="flag">
              <span className="flag__name" title={flag.name}>
                {flag.name}
              </span>
              <label className="switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`Toggle ${flag.name}`}
                  checked={flag.enabled}
                  onChange={(e) => {
                    toggleFlag(flag.id, e.target.checked, flag.version);
                  }}
                />
                <span className="switch__track" aria-hidden="true" />
              </label>
              <button
                type="button"
                className="flag__delete"
                aria-label={`Delete ${flag.name}`}
                onClick={() => {
                  deleteFlag(flag.id);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
