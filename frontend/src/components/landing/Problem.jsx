import { Reveal } from "./shared";

const PAINS = [
  {
    n: "01",
    title: "Late detection",
    desc: "By the time a stalled consumer shows up in a daily report, hours of events have backed up unnoticed.",
  },
  {
    n: "02",
    title: "Fragmented tooling",
    desc: "Ingestion logs in one place, processing metrics in another — and no single timeline that lines them up.",
  },
  {
    n: "03",
    title: "Silent failures",
    desc: "Retries exhaust, events dead-letter, and nothing surfaces until a downstream team asks where their data went.",
  },
  {
    n: "04",
    title: "Multi-tenant blind spots",
    desc: "One tenant's noisy producer hides another tenant's real outage when the pipeline has no per-workspace view.",
  },
];

/**
 * The problem, told editorially: a serif pull-quote on the left, hairline
 * pain rows on the right. No invented statistics — the pains are structural,
 * not numeric.
 */
export function Problem() {
  return (
    <section className="ls-problem">
      <Reveal className="ls-section ls-problem-grid">
        <div>
          <span className="ls-eyebrow">The problem</span>
          <p className="ls-problem-quote">
            You don't lack events. You lack <em>visibility</em> — into what
            happened, when, and why.
          </p>
          <p className="ls-problem-body">
            Modern services emit a constant stream of meaningful events. Most of it disappears
            into logs nobody reads, dashboards nobody trusts, and alerts that arrive after the
            damage is done.
          </p>
        </div>

        <div className="ls-pains">
          {PAINS.map((p) => (
            <div className="ls-pain" key={p.n}>
              <span className="ls-pain-n">{p.n}</span>
              <div>
                <h3 className="ls-pain-title">{p.title}</h3>
                <p className="ls-pain-desc">{p.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
