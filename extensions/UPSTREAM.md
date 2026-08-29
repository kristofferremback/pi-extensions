# Upstream provenance

The `subagents`, `workflows`, and supporting `shared` modules were adapted from:

- Repository: https://github.com/davis7dotsh/my-pi-setup
- Commit: `9b3ba1ad6aedfd932f9624044a5b996e0655dcca`
- Retrieved: 2026-07-18

Local changes include:

- Restricting in-process Pi children to `openai-codex/*` and `opencode-go/*`.
- Retaining the Claude Agent SDK backend for personal Claude subscription use.
- Supporting Pi, Claude Agent SDK, and Codex harnesses from workflow `agent()` calls.
- Adding a workflow skill and adapting the subagent skill to the local model policy.
- Bridging Pi 0.80.10's extension `ModelRegistry` to its child-session `ModelRuntime` API.
- Keeping plain-text result paths suitable for remote operation through Threa.

The upstream repository did not contain a visible license file when retrieved. These files are maintained here for private personal use; clarify permission with the upstream author before redistribution.
