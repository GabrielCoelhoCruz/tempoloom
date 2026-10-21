// Setup guides per AI tool on the Account page (docs/specs/integrations-ai-tools.md
// rules 10-13, 15-21): the client's steps with the MCP URL of this server, the
// OAuth sign-in, troubleshooting and how to disconnect. Steps that the spec does
// not give for a client are not invented; Tempoloom's own text is the sign-in on
// the consent page and the troubleshooting list.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

/**
 * A text with a Copy button. Where the Clipboard API is missing (plain http on a
 * host other than localhost) or refused, the text is selected and a message asks
 * the user to copy it by hand.
 */
export function Copyable(props: { text: string; testId: string; block?: boolean }) {
  const [state, setState] = useState<"copied" | "failed" | null>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (state !== "copied") return;
    const t = setTimeout(() => setState(null), 2000);
    return () => clearTimeout(t);
  }, [state]);
  const failed = () => {
    const el = textRef.current;
    const sel = window.getSelection();
    if (el && sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    setState("failed");
  };
  const copy = () => {
    const done = navigator.clipboard?.writeText(props.text);
    if (!done) return failed();
    void done.then(() => setState("copied"), failed);
  };
  return (
    <div class="copyable" data-testid={props.testId}>
      <span ref={textRef}>{props.block ? <pre>{props.text}</pre> : <code>{props.text}</code>}</span>{" "}
      <button type="button" onClick={copy}>
        Copy
      </button>
      {state === "copied" && <span class="meta"> Copied</span>}
      {state === "failed" && (
        <span class="error" role="alert">
          {" "}
          Copy failed: the text is selected, copy it with your keyboard.
        </span>
      )}
    </div>
  );
}

const SIGN_IN =
  "Tempoloom opens in your browser and names the AI tool. Check the Tempoloom account at the top of the page, then click Allow access.";
const LISTED = "The tool then shows under Connected AI tools below.";

function Trouble(props: { app: string; url: string; extra?: ComponentChildren }) {
  return (
    <>
      <h4>If it does not connect</h4>
      <ul data-testid="guide-trouble">
        <li>
          Check that the URL is exactly <code>{props.url}</code>.
        </li>
        <li>Use the same email in {props.app} and in Tempoloom.</li>
        {props.extra}
        <li>Restart or refresh {props.app}.</li>
        <li>Remove the connection and add it again.</li>
        <li>Authenticate again: the sign-in ends after 30 days without use.</li>
      </ul>
    </>
  );
}

type Client = "ChatGPT" | "Claude" | "Claude Code" | "Cursor" | "Other MCP clients";
const CLIENTS: Client[] = ["ChatGPT", "Claude", "Claude Code", "Cursor", "Other MCP clients"];

function Guide(props: { client: Client; url: string }) {
  const { url } = props;
  switch (props.client) {
    case "ChatGPT":
      return (
        <>
          <ol data-testid="guide-steps">
            <li>
              In ChatGPT, add a custom connector with the MCP URL above. Your ChatGPT plan must
              allow custom connectors.
            </li>
            <li>Complete the OAuth sign-in in the browser. {SIGN_IN}</li>
            <li>{LISTED}</li>
          </ol>
          <Trouble app="ChatGPT" url={url} />
          <p class="status">
            To disconnect: in ChatGPT settings, open apps or connected apps, then click Disconnect.
          </p>
        </>
      );
    case "Claude":
      return (
        <>
          <p>For Claude Desktop and the Claude web app.</p>
          <ol data-testid="guide-steps">
            <li>Open Settings, then the connectors section.</li>
            <li>Add a custom connector and name it, for example "Tempoloom".</li>
            <li>Enter the MCP URL above.</li>
            <li>Complete the OAuth sign-in in the browser. {SIGN_IN}</li>
            <li>
              Grant the tool permissions in Claude. Set tools that create or change events to "needs
              approval". {LISTED}
            </li>
          </ol>
          <Trouble app="Claude" url={url} />
          <p class="status">
            To disconnect: in Claude's connectors settings, click Disconnect or Remove.
          </p>
        </>
      );
    case "Claude Code":
      return (
        <>
          <ol data-testid="guide-steps">
            <li>
              Run this command:{" "}
              <Copyable text={`claude mcp add tempoloom -t http ${url}`} testId="guide-command" />
            </li>
            <li>Restart Claude Code.</li>
            <li>
              Open the MCP server list, select tempoloom and authenticate in the browser. {SIGN_IN}
            </li>
            <li>
              <code>claude mcp list</code> shows the server as connected. {LISTED}
            </li>
          </ol>
          <Trouble
            app="Claude Code"
            url={url}
            extra={
              <li>
                To reinstall, run <code>claude mcp remove tempoloom</code> and add it again.
              </li>
            }
          />
          <p class="status">
            To disconnect: run <code>claude mcp remove tempoloom</code>.
          </p>
        </>
      );
    case "Cursor": {
      const json = JSON.stringify({ mcpServers: { tempoloom: { type: "http", url } } }, null, 2);
      return (
        <>
          <ol data-testid="guide-steps">
            <li>
              Open Cursor settings, then Tools & MCP, then New MCP Server. Cursor opens mcp.json.
            </li>
            <li>
              Add this entry inside <code>mcpServers</code> and keep any other entries:
              <Copyable text={json} testId="guide-json" block />
            </li>
            <li>
              Save the file. The server shows in Cursor: click Connect and complete the OAuth
              sign-in in the browser. {SIGN_IN}
            </li>
            <li>{LISTED}</li>
          </ol>
          <h4>If it does not connect</h4>
          <ul data-testid="guide-trouble">
            <li>
              Check that the URL is exactly <code>{url}</code>, and check the JSON syntax of
              mcp.json.
            </li>
            <li>Restart Cursor.</li>
            <li>Authenticate again: click Connect for tempoloom.</li>
          </ul>
          <p class="status">
            To disconnect: remove the server in Cursor settings, or delete the tempoloom entry from
            mcp.json.
          </p>
        </>
      );
    }
    case "Other MCP clients":
      return (
        <>
          <p>
            Any client that supports remote MCP servers with OAuth can use the MCP URL above:{" "}
            <code>{url}</code>.
          </p>
          <p>
            The setup steps depend on the client. {SIGN_IN} A client without OAuth can use a
            personal API key as the bearer token.
          </p>
        </>
      );
  }
}

const PANEL = "mcp-guide-panel";
const tabId = (c: Client) => `mcp-guide-${c.toLowerCase().replace(/ /g, "-")}`;

export function McpGuides(props: { url: string }) {
  const [client, setClient] = useState<Client>("ChatGPT");
  return (
    <div data-testid="mcp-guides">
      <h3>Setup guides</h3>
      <div class="actions" role="tablist" aria-label="AI tool">
        {CLIENTS.map((c) => (
          <button
            type="button"
            role="tab"
            key={c}
            id={tabId(c)}
            aria-controls={PANEL}
            aria-selected={client === c}
            class={client === c ? "primary" : ""}
            onClick={() => setClient(c)}
          >
            {c}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={PANEL} aria-labelledby={tabId(client)} data-client={client}>
        <Guide client={client} url={props.url} />
      </div>
    </div>
  );
}
