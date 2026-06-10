import { useMemo, useState } from "react";

const API_BASE = "https://hubtiger-api.azurewebsites.net";
const SERVICES_BASE = "https://hubtigerservices.azurewebsites.net";

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

// Best-effort field extraction because the response keys can vary by tenant/version.
function normalizeJob(row) {
  const id =
    row?.ID ??
    row?.Id ??
    row?.JobCardID ??
    row?.JobCardId ??
    row?.ServiceRequestID ??
    row?.ServiceRequestId ??
    "";

  const firstName =
    row?.FirstName ??
    row?.Firstname ??
    row?.CustomerFirstName ??
    row?.CyclistFirstName ??
    row?.Name ??
    row?.GivenName ??
    "";

  const lastName =
    row?.LastName ??
    row?.Lastname ??
    row?.CustomerLastName ??
    row?.CyclistLastName ??
    row?.Surname ??
    row?.FamilyName ??
    "";

  const cyclistDescription =
    row?.CyclistDescription ??
    row?.Description ??
    row?.BikeDescription ??
    row?.Notes ??
    "";

  const email =
    row?.Email ??
    row?.EmailAddress ??
    row?.CustomerEmail ??
    row?.CyclistEmail ??
    "";

  const phone =
    row?.Phone ??
    row?.PhoneNumber ??
    row?.Mobile ??
    row?.MobileNumber ??
    row?.CustomerPhone ??
    row?.CyclistPhone ??
    "";

  return {
    raw: row,
    id: safeStr(id),
    firstName: safeStr(firstName),
    lastName: safeStr(lastName),
    cyclistDescription: safeStr(cyclistDescription),
    email: safeStr(email),
    phone: safeStr(phone),
  };
}

async function hubtigerLogin({ username, password, code }) {
  // Your capture showed Content-Type: application/x-www-form-urlencoded with JSON in body.
  // We'll keep that behavior to match the portal.
  const url = `${API_BASE}/api/Auth/ValidateLogin?code=${encodeURIComponent(code)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: JSON.stringify({ username, password, skipped: false }),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Login failed: HTTP ${res.status} (non-JSON response): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    throw new Error(`Login failed: HTTP ${res.status}: ${safeStr(json?.Message || text).slice(0, 300)}`);
  }

  if (!json?.legacyToken) {
    throw new Error("Login succeeded but legacyToken was missing in response.");
  }

  return {
    userName: json.userName,
    token: json.token,
    legacyToken: json.legacyToken,
  };
}

async function jobCardSearch({ partnerId, legacyToken, query, searchAllStores }) {
  const url = `${SERVICES_BASE}/api/ServiceRequest/JobCardSearch`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${legacyToken}`, // <- confirmed working
    },
    body: JSON.stringify({
      PartnerID: Number(partnerId),
      Search: query,
      SearchAllStores: !!searchAllStores,
    }),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Search failed: HTTP ${res.status} (non-JSON response): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    throw new Error(`Search failed: HTTP ${res.status}: ${safeStr(json?.Message || text).slice(0, 300)}`);
  }

  if (!Array.isArray(json)) {
    // Some backends return { Message: "..."} etc.
    throw new Error(`Search returned unexpected shape: ${text.slice(0, 200)}`);
  }

  return json;
}

export default function App() {
  const code = import.meta.env.VITE_HUBTIGER_CODE;
  const partnerId = import.meta.env.VITE_PARTNER_ID;

  const [username, setUsername] = useState("ian@smartmotionbikes.com.au");
  const [password, setPassword] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);

  const [jwt, setJwt] = useState("");
  const [legacyToken, setLegacyToken] = useState("");
  const [who, setWho] = useState("");

  const [query, setQuery] = useState("john");
  const [searchAllStores, setSearchAllStores] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [rows, setRows] = useState([]);

  const normalizedRows = useMemo(() => rows.map(normalizeJob), [rows]);

  async function onLogin(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (!code) throw new Error("Missing VITE_HUBTIGER_CODE in .env");
      if (!partnerId) throw new Error("Missing VITE_PARTNER_ID in .env");
      if (!username || !password) throw new Error("Username + password required.");

      const r = await hubtigerLogin({ username, password, code });
      setJwt(r.token || "");
      setLegacyToken(r.legacyToken || "");
      setWho(r.userName || "");
      setLoggedIn(true);
    } catch (err) {
      setError(err?.message || String(err));
      setLoggedIn(false);
    } finally {
      setLoading(false);
    }
  }

  async function onSearch(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (!legacyToken) throw new Error("Missing legacyToken (login first).");
      if (!query?.trim()) throw new Error("Search query required.");

      const r = await jobCardSearch({
        partnerId,
        legacyToken,
        query: query.trim(),
        searchAllStores,
      });

      setRows(r);
    } catch (err) {
      setError(err?.message || String(err));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  function onLogout() {
    setLoggedIn(false);
    setJwt("");
    setLegacyToken("");
    setWho("");
    setRows([]);
    setError("");
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 16, maxWidth: 1200, margin: "0 auto" }}>
      <h2>Hubtiger Job Search</h2>
      <div style={{ opacity: 0.8, marginBottom: 12 }}>
        PartnerID: <b>{partnerId || "(missing)"}</b>
      </div>

      {!loggedIn ? (
        <form onSubmit={onLogin} style={{ display: "grid", gap: 10, maxWidth: 520, padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
          <div style={{ fontWeight: 700 }}>Login</div>

          <label style={{ display: "grid", gap: 6 }}>
            <span>Username</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="email" />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span>Password</span>
            <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" type="password" />
          </label>

          <button disabled={loading} type="submit">
            {loading ? "Logging in..." : "Login"}
          </button>

          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Uses ValidateLogin and stores JWT + legacyToken in memory (browser). For production, move auth server-side.
          </div>
        </form>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div>
              Logged in as <b>{who}</b>
            </div>
            <button onClick={onLogout}>Logout</button>
          </div>

          <form onSubmit={onSearch} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search (name, surname, cyclist description, etc.)"
              style={{ minWidth: 360 }}
            />
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={searchAllStores} onChange={(e) => setSearchAllStores(e.target.checked)} />
              Search all stores
            </label>
            <button disabled={loading} type="submit">
              {loading ? "Searching..." : "Search"}
            </button>
          </form>

          {error ? (
            <div style={{ padding: 12, border: "1px solid #f99", background: "#fff5f5", borderRadius: 8 }}>
              <b>Error:</b> {error}
            </div>
          ) : null}

          <div style={{ opacity: 0.85 }}>
            Results: <b>{normalizedRows.length}</b>
          </div>

          <div style={{ overflowX: "auto", border: "1px solid #ddd", borderRadius: 8 }}>
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
                {normalizedRows.map((r, idx) => (
                  <tr key={`${r.id}-${idx}`}>
                    <td style={{ padding: 10, borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>{r.id}</td>
                    <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{r.firstName}</td>
                    <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{r.lastName}</td>
                    <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{r.cyclistDescription}</td>
                    <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{r.email}</td>
                    <td style={{ padding: 10, borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>{r.phone}</td>
                  </tr>
                ))}

                {!normalizedRows.length ? (
                  <tr>
                    <td colSpan={6} style={{ padding: 14, opacity: 0.7 }}>
                      No results yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <details style={{ marginTop: 8 }}>
            <summary>Debug (tokens)</summary>
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                Keep tokens out of logs in production. This is only for quick server bring-up.
              </div>
              <textarea readOnly value={jwt} rows={3} />
              <textarea readOnly value={legacyToken} rows={3} />
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
