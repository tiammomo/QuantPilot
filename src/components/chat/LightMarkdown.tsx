import React, { type ReactElement } from "react";

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;
  let lastIndex = 0;
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `inline-${index++}`;
    if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code
          key={key}
          className="bg-slate-100 px-2 py-1 rounded text-xs font-mono break-all"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (
      (token.startsWith("**") && token.endsWith("**")) ||
      (token.startsWith("__") && token.endsWith("__"))
    ) {
      nodes.push(
        <strong key={key} className="font-medium">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (
      (token.startsWith("*") && token.endsWith("*")) ||
      (token.startsWith("_") && token.endsWith("_"))
    ) {
      nodes.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>,
      );
    } else {
      nodes.push(token);
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

const parseMarkdownTableRow = (line: string): string[] => {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];

  const normalized = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = normalized.split("|").map((cell) => cell.trim());
  return cells.filter((cell, index) => cell || index < cells.length);
};

const isMarkdownTableSeparator = (line: string): boolean => {
  const cells = parseMarkdownTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
};

const renderMarkdownTable = (
  headers: string[],
  rows: string[][],
  key: string,
): ReactElement => (
  <div key={key} className="my-3 w-full overflow-x-auto">
    <table className="min-w-full border-collapse border border-slate-300 text-sm">
      <thead className="bg-slate-50">
        <tr>
          {headers.map((header, index) => (
            <th
              key={index}
              className="border border-slate-300 px-3 py-2 text-left font-semibold text-slate-800"
            >
              {renderInlineMarkdown(header)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {headers.map((_, cellIndex) => (
              <td
                key={cellIndex}
                className="border border-slate-300 px-3 py-2 align-top text-slate-700"
              >
                {renderInlineMarkdown(row[cellIndex] ?? "")}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export function renderLightMarkdown(
  content: string,
  options: { codeBreakAll?: boolean } = {},
): ReactElement {
  const blocks: React.ReactNode[] = [];
  const lines = content.split(/\r?\n/);
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let codeFence: { language: string; lines: string[] } | null = null;

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    paragraph = [];
    if (!text) return;
    if (text.includes("Planning for next moves...")) {
      blocks.push(
        <p key={`p-${blocks.length}`} className="mb-2 last:mb-0 break-words">
          <code className="bg-slate-100 px-2 py-1 rounded text-xs font-mono">
            Planning for next moves...
          </code>
        </p>,
      );
      return;
    }
    blocks.push(
      <p key={`p-${blocks.length}`} className="mb-2 last:mb-0 break-words">
        {renderInlineMarkdown(text)}
      </p>,
    );
  };

  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    const className = list.ordered
      ? "list-decimal list-inside mb-2 space-y-1"
      : "list-disc list-inside mb-2 space-y-1";
    blocks.push(
      <Tag key={`list-${blocks.length}`} className={className}>
        {list.items.map((item, index) => (
          <li key={index} className="mb-1 break-words">
            {renderInlineMarkdown(item)}
          </li>
        ))}
      </Tag>,
    );
    list = null;
  };

  const flushCodeFence = () => {
    if (!codeFence) return;
    blocks.push(
      <pre
        key={`pre-${blocks.length}`}
        className="bg-slate-100 p-3 rounded-lg my-2 overflow-x-auto text-xs break-words"
      >
        <code>{codeFence.lines.join("\n")}</code>
      </pre>,
    );
    codeFence = null;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const fenceMatch = line.match(/^```(\w+)?\s*$/);
    if (fenceMatch) {
      if (codeFence) {
        flushCodeFence();
      } else {
        flushParagraph();
        flushList();
        codeFence = { language: fenceMatch[1] ?? "", lines: [] };
      }
      continue;
    }

    if (codeFence) {
      codeFence.lines.push(line);
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      const headingClassName =
        level <= 2
          ? "mb-2 mt-3 text-sm font-semibold text-slate-900 first:mt-0"
          : "mb-2 mt-2 text-xs font-semibold text-slate-800 first:mt-0";
      const Tag = level <= 2 ? "h3" : "h4";
      blocks.push(
        <Tag key={`heading-${blocks.length}`} className={headingClassName}>
          {renderInlineMarkdown(headingMatch[2].trim())}
        </Tag>,
      );
      continue;
    }

    const tableHeaders = parseMarkdownTableRow(line);
    const nextLine = lines[lineIndex + 1] ?? "";
    if (tableHeaders.length > 1 && isMarkdownTableSeparator(nextLine)) {
      flushParagraph();
      flushList();
      const tableRows: string[][] = [];
      lineIndex += 2;

      while (lineIndex < lines.length) {
        const row = parseMarkdownTableRow(lines[lineIndex]);
        if (row.length <= 1 || isMarkdownTableSeparator(lines[lineIndex])) {
          break;
        }
        tableRows.push(row);
        lineIndex++;
      }

      lineIndex--;
      blocks.push(
        renderMarkdownTable(tableHeaders, tableRows, `table-${blocks.length}`),
      );
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const unorderedMatch = line.match(/^\s*[-*]\s+(.+)$/);
    const orderedMatch = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unorderedMatch || orderedMatch) {
      flushParagraph();
      const ordered = Boolean(orderedMatch);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((unorderedMatch?.[1] ?? orderedMatch?.[1] ?? "").trim());
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushCodeFence();
  flushParagraph();
  flushList();

  if (blocks.length === 0) {
    blocks.push(
      <p key="empty" className="mb-2 last:mb-0 break-words">
        {options.codeBreakAll ? "" : content}
      </p>,
    );
  }

  return <>{blocks}</>;
}
