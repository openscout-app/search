import React, { useEffect, useRef, useState } from "react";

function highlightTerms(text, query) {
  const terms = query.trim().split(/\s+/u).filter(term => term.length > 1)
    .sort((a, b) => b.length - a.length)
    .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return [{ text, match: false }];
  const pattern = new RegExp("(" + terms.join("|") + ")", "giu");
  return text.split(pattern).map((part, i) => ({ text: part, match: i % 2 === 1 }));
}

function SourceReference({ fields }) {
  const [state, setState] = useState("ready");
  const manual = useRef(null);
  const reset = useRef(null);
  useEffect(() => () => clearTimeout(reset.current), []);
  useEffect(() => {
    if (state === "manual") {
      manual.current?.focus();
      manual.current?.select();
    }
  }, [state]);

  if (!fields?.length) return <div className="sp-source">Source coordinates are unavailable for this passage.</div>;
  const text = fields.map(({ label, value }) => label + "  " + value).join("\n");
  async function copy() {
    clearTimeout(reset.current);
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      reset.current = setTimeout(() => setState("ready"), 1500);
    } catch {
      setState("manual");
      manual.current?.focus();
      manual.current?.select();
    }
  }
  return <div className="sp-source">
    <div className="sp-coords">{fields.map(({ label, value }) => (
      <span key={label} title={label + " · " + value} className={label === "Transcript" ? "sp-path" : undefined}>
        <span className={label === "Transcript" || label === "Session" ? "sp-sr-only" : undefined}>{label} </span>
        <bdi>{value}</bdi>
      </span>
    ))}</div>
    <button type="button" className="sp-copy" onClick={copy}>
      {state === "copied" ? "Copied" : state === "manual" ? "Select reference" : "Copy reference"}
    </button>
    {state === "manual" && <textarea className="sp-manual-copy" ref={manual} readOnly value={text}
      rows={fields.length} aria-label="Source reference. Use your device’s copy command." />}
  </div>;
}

function Passage({ passage, query, highlight, selected }) {
  const { text, title, metadata, reference, onSelect, onOpen } = passage;
  const excerpt = highlight(text, query).map((part, i) => part.match ? <mark key={i}>{part.text}</mark> : part.text);
  if (!onSelect) {
    return <details className="sp-passage">
      <summary className="sp-summary"><span className="sp-excerpt">{excerpt}</span></summary>
      <SourceReference fields={reference} />
    </details>;
  }
  return <article className="sp-option" role="option" aria-selected={selected} tabIndex={0}
    onClick={onSelect} onDoubleClick={onOpen}
    onKeyDown={event => {
      if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && onOpen) onOpen();
      else onSelect();
    }}>
    {metadata}
    {title && <h3 className="sp-title">{title}</h3>}
    {text && <p className="sp-excerpt">{excerpt}</p>}
  </article>;
}

export function PassageList({ groups, query, selectedId, busy, highlight = highlightTerms, className = "" }) {
  return <div className={("sp-list " + className).trim()} aria-busy={busy}>
    {groups.map((group, index) => (
      <section className="sp-group" aria-label={group.label ?? "Session " + (index + 1)} key={group.id}>
        <header className="sp-group-head">{group.header}</header>
        <div className="sp-passages">{group.passages.map(passage => (
          <Passage key={passage.id} passage={passage} query={query} highlight={highlight} selected={selectedId === passage.id} />
        ))}</div>
      </section>
    ))}
  </div>;
}
