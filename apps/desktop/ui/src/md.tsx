import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

export function Md(props: { text: string; class?: string }) {
  const html = () =>
    DOMPurify.sanitize(marked.parse(props.text, { async: false }) as string);
  return <div class={`md ${props.class ?? ""}`} innerHTML={html()} />;
}
