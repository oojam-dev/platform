import { Link } from "react-router";

export function ErrorPage({ code, title, detail, stack }: { code: string; title: string; detail?: string; stack?: string }) {
  return (
    <section className="py-10 sm:py-16">
      <p aria-hidden="true" className="wordmark text-[5.5rem] text-jam sm:text-[8rem]">
        {code}
      </p>
      <h1 className="mt-2 font-display text-3xl font-black tracking-tight sm:text-4xl">{title}</h1>
      {detail && <p className="mt-3 max-w-xl text-lg text-ink-2">{detail}</p>}
      <div className="mt-8 flex flex-wrap gap-3">
        <Link to="/" className="btn btn-jam">
          Back to the board
        </Link>
        <Link to="/ideas/new" className="btn btn-ghost">
          Post an idea
        </Link>
      </div>
      {stack && (
        <pre className="mt-10 overflow-x-auto rounded-2xl bg-sunk p-4 font-mono text-xs text-ink-2">
          <code>{stack}</code>
        </pre>
      )}
    </section>
  );
}
