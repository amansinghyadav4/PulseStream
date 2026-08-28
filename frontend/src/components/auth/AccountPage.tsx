import { Card } from "../../ui/Card";
import { DetailRow } from "../../ui/Drawer";
import { useAuth } from "../../context/AuthContext";
import { navigateTo } from "../../lib/router";
import { IconKey, IconTerminal } from "../icons";

/** Account / settings — rendered inside the dashboard shell. Read-only profile
 *  + workspace summary, quick links to developer surfaces, and a sign-out
 *  action. Tenant data (organization) is server-derived; nothing here is
 *  client-supplied. */
export function AccountPage() {
  const { user } = useAuth();
  if (!user) return null;

  const created = (() => {
    try {
      return new Date(user.created_at).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" });
    } catch {
      return user.created_at;
    }
  })();

  const initial = (user.full_name || user.email).charAt(0).toUpperCase();

  return (
    <>
      <Card title="Profile" hint="your account details">
        <div className="account-identity">
          <span className="account-avatar" aria-hidden="true">
            {initial}
          </span>
          <div className="account-identity-meta">
            <div className="account-identity-name">{user.full_name || "—"}</div>
            <div className="account-identity-email">{user.email}</div>
          </div>
          <span className={`badge ${user.is_active ? "ok" : "neutral"}`}>
            {user.is_active ? (
              <>
                <span className="dot" aria-hidden /> Active
              </>
            ) : (
              "Inactive"
            )}
          </span>
        </div>
        <DetailRow label="Full name">{user.full_name || "—"}</DetailRow>
        <DetailRow label="Email">{user.email}</DetailRow>
        <DetailRow label="Member since">{created}</DetailRow>
      </Card>

      <Card title="Workspace" hint="your organization / tenant">
        <DetailRow label="Organization">{user.organization.name}</DetailRow>
        <DetailRow label="Slug">
          <span className="mono">{user.organization.slug}</span>
        </DetailRow>
        <DetailRow label="Workspace ID">
          <span className="mono">{user.organization.id}</span>
        </DetailRow>
        <p className="metric-definition" style={{ marginTop: 4 }}>
          Every event you send and every dashboard view is isolated to this workspace. The organization is resolved
          server-side from your session — it can never be set by a client.
        </p>
      </Card>

      <Card title="Developer" hint="connect your application">
        <div className="account-links">
          <button type="button" className="account-link" onClick={() => navigateTo("api-keys")}>
            <span className="account-link-icon">
              <IconKey size={16} />
            </span>
            <span className="account-link-meta">
              <span className="account-link-title">API Keys</span>
              <span className="account-link-sub">Create and revoke ingest credentials</span>
            </span>
            <span className="account-link-arrow" aria-hidden>
              →
            </span>
          </button>
          <button type="button" className="account-link" onClick={() => navigateTo("integrations")}>
            <span className="account-link-icon">
              <IconTerminal size={16} />
            </span>
            <span className="account-link-meta">
              <span className="account-link-title">Integration guide</span>
              <span className="account-link-sub">Endpoint, schema and code examples</span>
            </span>
            <span className="account-link-arrow" aria-hidden>
              →
            </span>
          </button>
        </div>
      </Card>

      <Card title="Session" hint="sign out of this device">
        <div className="account-actions">
          <p className="metric-definition" style={{ margin: 0 }}>
            Signing out revokes this session on the server. You'll need to sign in again to return to the dashboard.
          </p>
          <button type="button" className="btn danger" onClick={() => navigateTo("logout")}>
            Sign out
          </button>
        </div>
      </Card>
    </>
  );
}
