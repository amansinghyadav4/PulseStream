import { Reveal, SECTION } from "./shared";
import { CopyButton } from "../CopyButton";
import { IconArrowRight } from "../icons";

const CONNECT_SNIPPET = `curl -X POST https://<your-host>/api/v1/events \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "event_type": "order.created", "source": "checkout-service" }'`;

/** The real stack as a typeset table — layer on the left, the technologies
 *  that actually run this deployment on the right. Not a logo wall: each row
 *  states what the layer does, and every chip is something this codebase
 *  genuinely uses. */
const STACK = [
  { layer: "Frontend", items: ["React", "Vite"] },
  { layer: "API", items: ["FastAPI", "Pydantic"] },
  { layer: "Transport", items: ["Kafka", "WebSockets"] },
  { layer: "Workers", items: ["aiodataloader", "SQLAlchemy"] },
  { layer: "Storage", items: ["PostgreSQL", "Redis"] },
  { layer: "Platform", items: ["Docker Compose", "nginx"] },
];

/**
 * Developer credibility: the one-request integration on the left (real
 * endpoint, real header, copyable), the stack table on the right.
 */
export function DevSection({ navigate }) {
  return (
    <section id={SECTION.developer} className="ls-section">
      <Reveal className="ls-dev">
        <div className="ls-dev-copy">
          <span className="ls-eyebrow">For developers</span>
          <h2 className="ls-h2">
            Connect any application in <span className="ls-h2-accent">one request</span>
          </h2>
          <p className="ls-sub">
            Any external service can send events over plain HTTP — one POST
            with your workspace API key. No SDK to install, no agent to run.
            From there the platform validates, buffers, processes and streams
            the result back to your dashboard.
          </p>

          <div className="code-block ls-code">
            <div className="code-block-head">
              <span className="code-lang">Shell</span>
              <CopyButton value={CONNECT_SNIPPET} className="btn" label="Copy" compact />
            </div>
            <pre className="code-body"><code>{CONNECT_SNIPPET}</code></pre>
          </div>

          <button
            type="button"
            className="ls-btn ls-btn-primary ls-btn-lg"
            onClick={() => navigate("signup")}
          >
            Start sending events
            <IconArrowRight size={14} />
          </button>
        </div>

        <div>
          <h3 className="ls-stack-heading">The stack behind the numbers</h3>
          <div className="ls-stack">
            {STACK.map((row) => (
              <div className="ls-stack-row" key={row.layer}>
                <span className="ls-stack-layer">{row.layer}</span>
                <div className="ls-stack-items">
                  {row.items.map((it) => (
                    <span className="ls-stack-chip" key={it}>{it}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Reveal>
    </section>
  );
}
