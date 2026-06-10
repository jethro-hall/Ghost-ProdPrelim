import { useMemo, useState } from "react";

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

// Because Hubtiger field names can vary, we normalize to what you want.
function normalize(row) {
  const id = row?.ID ?? row?.Id ?? row?.JobCardID ?? row?.JobCardId ?? "";
  const name = row?.FirstName ?? row?.Firstname ?? row?.Name ?? row?.GivenName ?? "";
  const surname = row?.LastName ?? row?.Lastname ?? row?.Surname ?? row?.FamilyName ?? "";
  const cyclistDescription = row?.CyclistDescription ?? row?.Description ?? row?.BikeDescription ?? row?.Notes ?? "";
  const email = row?.Email ?? row?.EmailAddress ?? row?.CustomerEmail ?? "";
  const phone = row?.Phone ?? row?.PhoneNumber ?? row?.Mobile ?? row?.MobileNumber ?? "";

  return {
    id: safeStr(id),
    name: safeStr(name),
    surname: safeStr(surname),
    cyclistDescription: safeStr(cyclistDescription),
    email: safeStr(email),
    phone: safeStr(phone),
    raw: row
  };
}

export default function App() {
  const [q, setQ] = useState("john");
  const [allStores, setAllStores] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [who, setWho] = useState("");
  const [rows, setRows] = useState([]);

  const norm = useMemo(() => rows.map(normalize), [rows]);

  async function search(e) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const res = await fetch("/admin/api/hubtiger/jobs/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q, allStores })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Search failed");
      setWho(json.userName || "");
      setRows(json.rows || []);
    } catch (ex) {
      setErr(ex?.message || String(ex));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 1200, margin: "0 auto" }}>
      <h2>Hubtiger Job Search</h2>
      <div style={{ opacity: 0.8, marginBottom: 10 }}>
        {who ? <>Authenticated as <b>{who}</b> (server-side, every request).</> : "Not searched yet."}
      </div>

      <form onSubmit={search} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search: name / surname / cyclist description / ID / email / phone"
          style={{ minWidth: 420 }}
        />
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={allStores} onChange={(e) => setAllStores(e.target.checked)} />
          Search all stores
        </label>
        <button disabled={loading}>{loading ? "Searching..." : "Search"}</button>
      </form>

      {err ? (
        <div style={{ marginTop: 12, padding: 12, border: "1px solid #f99", borderRadius: 8 }}>
          <b>Error:</b> {err}
        </div>
      ) : null}

      <div style={{ marginTop: 12, opacity: 0.85 }}>
        Results: <b>{norm.length}</b>
      </div>

      <div style={{ overflowX: "auto", border: "1px solid #ddd", borderRadius: 8, marginTop: 10 }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {["ID", "Name", "Surname", "Cyclist Description", "Email", "Phone"].map((h) => (
                <th key={h} style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #ddd", whiteSpace: "nowrap" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {norm.map((r, i) => (
              <tr key={`${r.id}-${i}`}>
                <td style={{ padding: 10, borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>{r.id}</td>
                <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{r.name}</td>
                <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{r.surname}</td>
                <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{r.cyclistDescription}</td>
                <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{r.email}</td>
                <td style={{ padding: 10, borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>{r.phone}</td>
              </tr>
            ))}
            {!norm.length ? (
              <tr><td colSpan={6} style={{ padding: 14, opacity: 0.7 }}>No results.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
