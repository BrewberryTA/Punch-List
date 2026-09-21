import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Item, type TodaySite } from "../api/client";

export function TodayPage() {
  const [asOf, setAsOf] = useState<string | null>(null);
  const [sites, setSites] = useState<TodaySite[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await api.today();
      setAsOf(res.asOf);
      setSites(res.sites);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function complete(item: Item) {
    await api.completeItem(item.id);
    void load();
  }

  const totalItems = sites?.reduce((n, s) => n + s.items.length, 0) ?? 0;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Today</h1>
        <Link className="link-button" to="/">
          Projects
        </Link>
      </header>

      {error && <p className="error">{error}</p>}
      {sites === null && !error && <p>Loading…</p>}

      {sites && sites.length === 0 && (
        <p>Nothing due today or overdue. Nice.</p>
      )}

      {sites && sites.length > 0 && (
        <p className="muted">
          {asOf}: {totalItems} item(s) due across {sites.length} site(s).
        </p>
      )}

      {sites?.map((site) => (
        <div key={site.projectId} className="card">
          <h2>{site.projectName}</h2>
          {site.projectAddress && <p className="muted">{site.projectAddress}</p>}
          <ul className="list">
            {site.items.map((item) => (
              <li key={item.id} className="list-row">
                <div>
                  <strong>{item.room ?? "Unspecified area"}</strong>
                  <div>{item.description}</div>
                  <div className="muted">
                    Due {item.commitment_date}
                    {item.trade ? ` · ${item.trade}` : ""}
                  </div>
                </div>
                <button className="secondary" onClick={() => void complete(item)}>
                  Mark done
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
