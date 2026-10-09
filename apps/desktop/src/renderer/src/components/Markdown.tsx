/**
 * A deliberately small Markdown renderer. It builds React nodes directly and
 * never sets innerHTML: model output is untrusted, and a page the agent read
 * could have steered it into emitting markup.
 */

import { Fragment, type ReactNode } from "react";
import { t } from "@vunemi/i18n";
import { parseBlocks, plainMath } from "../lib/markdown";

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;

function inlineNodes(text: string, unverified?: readonly string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(plainMath(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(
        <code key={key++} className="rounded bg-surface-2 px-1 py-px font-mono text-[0.88em]">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**")) {
      out.push(<strong key={key++} className="font-semibold">{plainMath(tok.slice(2, -2))}</strong>);
    } else if (tok.startsWith("*")) {
      out.push(<em key={key++}>{plainMath(tok.slice(1, -1))}</em>);
    } else {
      const [, label, href] = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      // Only https links, opened by the main process in the real browser.
      out.push(
        href!.startsWith("https://") ? (
          <Fragment key={key++}>
            <a href={href} target="_blank" rel="noreferrer" className="text-ember underline decoration-ember-line underline-offset-2">
              {label}
            </a>
            {/* An address the conversation never held: the model wrote it from memory. */}
            {unverified?.includes(href!) && (
              <span title={t("turn.linkUnverifiedWhy")} className="ml-1 cursor-help text-[0.8em] text-faint">
                {t("turn.linkUnverified")}
              </span>
            )}
          </Fragment>
        ) : (
          <span key={key++}>{label}</span>
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(plainMath(text.slice(last)));
  return out;
}

export function Markdown({ text, unverified }: { text: string; unverified?: readonly string[] }) {
  const inline = (part: string): ReactNode[] => inlineNodes(part, unverified);
  return (
    <div className="selectable space-y-2.5 text-[14.5px] leading-[1.65] text-fg">
      {parseBlocks(text).map((b, i) => {
        switch (b.kind) {
          case "h":
            return (
              <p key={i} className={b.level <= 2 ? "pt-1 text-[15.5px] font-semibold" : "font-semibold"}>
                {inline(b.text)}
              </p>
            );
          case "code":
            return (
              <pre key={i} className="scroll-thin overflow-x-auto rounded-lg border border-line bg-surface-2 px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed">
                {b.text}
              </pre>
            );
          case "ul":
          case "ol": {
            const List = b.kind === "ul" ? "ul" : "ol";
            return (
              <List key={i} className={`space-y-1 pl-5 ${b.kind === "ul" ? "list-disc" : "list-decimal"} marker:text-faint`}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </List>
            );
          }
          case "table":
            return (
              <div key={i} className="scroll-thin overflow-x-auto rounded-lg border border-line">
                <table className="w-full border-collapse text-[13.5px]">
                  <thead className="bg-surface-2">
                    <tr>
                      {b.head.map((cell, j) => (
                        <th key={j} className="border-b border-line px-3 py-1.5 font-semibold" style={{ textAlign: b.align[j] ?? "left" }}>
                          {inline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r} className="border-t border-line first:border-t-0">
                        {b.head.map((_, j) => (
                          <td key={j} className="px-3 py-1.5 align-top" style={{ textAlign: b.align[j] ?? "left" }}>
                            {inline(row[j] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "quote":
            return (
              <blockquote key={i} className="border-l-2 border-line-strong pl-3 text-muted">
                {inline(b.text)}
              </blockquote>
            );
          default:
            return (
              <p key={i} className="whitespace-pre-wrap">
                {b.text.split("\n").map((ln, j, arr) => (
                  <Fragment key={j}>
                    {inline(ln)}
                    {j < arr.length - 1 && <br />}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
