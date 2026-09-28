---
name: Zed
website: https://zed.dev/
tagline: A fast, open source editor written in Rust with edit prediction, an agent panel and bring your own key AI.
vertical: developer-tools
category: Coding assistants
pricing: Freemium
bestFor: Developers who prioritise editor speed and want AI without giving up control of the model or the bill
rating: 4
addedDate: 2026-09-28
---

## What is Zed?

Zed is a code editor built from scratch in Rust by the team that previously made Atom and the Tree-sitter parser. It is open source, renders on the GPU, and opens large files and repositories noticeably faster than Electron-based editors. Language support comes through the standard language server protocol, so completions, go to definition and diagnostics work for most mainstream stacks out of the box, with extensions covering the rest.

The AI layer sits on top of that foundation rather than defining it. Edit prediction, powered by Zed's own open model, suggests the next change as you type and can jump to where the follow-on edit should happen. The agent panel takes a task in plain language, reads your project, edits multiple files and runs terminal commands, with every change shown as a reviewable diff. You can run the agent through Zed's hosted plans, or plug in your own API keys from the major model providers, or point it at a local model, in which case the AI features cost nothing beyond the provider's bill.

Zed also supports the Agent Client Protocol, which means external agents such as Claude Code or Gemini CLI can run inside the editor with their output rendered in the same panel. Real-time collaboration is built in: you can share a project, edit together, and talk over voice without leaving the editor. The free plan includes a modest monthly AI allowance and unlimited use with your own keys. Pro adds a larger hosted allowance.

## Where it shines

Speed is the first thing you notice. Startup is near instant, scrolling through a large file never stutters, and multi-cursor edits across thousands of lines feel immediate. For developers who have grown tired of waiting on their editor, this alone is enough reason to switch.

The bring your own key model is refreshingly honest. There is no credit scheme to decode; you pay your model provider directly and Zed takes nothing. Teams with existing API accounts, or those running local models for compliance reasons, get a capable agent without a second subscription.

The agent panel is well designed for review. Changes accumulate in a diff view with per-hunk accept and reject, tool calls are visible as they happen, and you can interrupt and redirect mid-task. Running an external agent through the protocol means you are not locked into Zed's own agent if another tool suits your workflow better.

Collaboration is a genuine differentiator. Pair programming with shared cursors and built-in voice works without a screen-share tool, and channels give distributed teams a persistent place to work together.

## Where it falls short

Windows support arrived later than macOS and Linux and is still catching up on polish, so Windows-first teams should test carefully before committing. The extension ecosystem is far smaller than VS Code's, and some niche language tooling, debugging integrations and framework-specific helpers simply do not exist yet. Debugging in general is newer and less mature than in established IDEs.

The hosted AI plans are less generous than dedicated AI editors, and the in-house edit prediction, while fast, is not as strong as the tab completion in [Cursor](/tools/cursor/). Enterprise features such as SSO, admin controls and usage analytics are thin, so larger organisations wanting a managed rollout will find [GitHub Copilot](/tools/github-copilot/) or [Windsurf](/tools/windsurf/) easier to administer.

## Conclusion

Zed is the best choice for developers who value a fast, minimal editor and want AI on their own terms, particularly through their own API keys or local models. It is not the choice for teams that need a mature extension ecosystem, strong Windows support, or enterprise administration. As an open source project with active development, it is improving quickly, and the agent panel already holds its own against more expensive tools.
