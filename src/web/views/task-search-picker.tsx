// Picks or creates a saved task search (planning-next-up.md NXT-40).
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";

export interface TaskSearch {
  id: string;
  name: string;
  keyword: string;
  due_within_days: number | null;
}

export interface SearchTask {
  id: string;
  title: string;
}

/** A select of the user's searches, plus a small form that creates one and selects it. */
export function TaskSearchPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [searches, setSearches] = useState<TaskSearch[]>([]);
  const [name, setName] = useState("");
  const [keyword, setKeyword] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = async () =>
    setSearches((await api<{ searches: TaskSearch[] }>("GET", "/api/task-searches")).searches);
  useEffect(() => void load(), []);

  const create = async () => {
    setError(null);
    try {
      const { search } = await api<{ search: TaskSearch }>("POST", "/api/task-searches", {
        name: name.trim() || keyword.trim(),
        keyword: keyword.trim(),
        ...(due ? { dueWithinDays: Number(due) } : {}),
      });
      await load();
      setName("");
      setKeyword("");
      setDue("");
      onChange(search.id);
    } catch {
      setError("Give the search a name or a word.");
    }
  };

  return (
    <div class="task-search">
      <label>
        Task search
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.currentTarget.value || null)}
          data-testid="task-search-select"
        >
          <option value="">None</option>
          {searches.map((s) => (
            <option value={s.id} key={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <details data-testid="new-task-search">
        <summary>New task search</summary>
        <label>
          Search name
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} maxLength={100} />
        </label>
        <label>
          Keyword
          <input
            value={keyword}
            onInput={(e) => setKeyword(e.currentTarget.value)}
            maxLength={100}
          />
        </label>
        <label>
          Due within (days)
          <input
            type="number"
            min={0}
            max={365}
            value={due}
            onInput={(e) => setDue(e.currentTarget.value)}
          />
        </label>
        <button type="button" onClick={() => void create()}>
          Save search
        </button>
        {error && <p class="error">{error}</p>}
      </details>
    </div>
  );
}

/** The open tasks that match a search, as a list. */
export function SearchTaskList({ tasks, name }: { tasks: SearchTask[]; name: string }) {
  return (
    <ul class="search-tasks" data-testid="search-tasks">
      {tasks.map((t) => (
        <li key={t.id} data-task={t.title}>
          {t.title}
        </li>
      ))}
      {tasks.length === 0 && <li class="meta">No open task matches {name}.</li>}
    </ul>
  );
}
