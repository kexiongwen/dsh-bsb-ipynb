# Security Policy

## Supported Versions

This project is pre-1.0. Security fixes go to the latest `main` and the most
recent tagged release; no long-term support branches exist.

## Reporting a Vulnerability

Please do **not** open a public issue for security problems.

Use GitHub's private vulnerability reporting:

<https://github.com/kexiongwen/dsh-bsb-ipynb/security/advisories/new>

If that form is unavailable, contact the maintainer through GitHub
(<https://github.com/kexiongwen>) and ask for a private channel. Please
include:

- the affected version or commit;
- DSH and dsh-better-sidebar versions;
- OS, Node.js and Python versions;
- reproduction steps and the impact you expect;
- a minimal notebook or script when possible.

Avoid including secrets, private notebook contents or third-party data unless
it is strictly necessary.

This is a spare-time project, so reports are handled on a best-effort basis.
Please allow reasonable time for a fix before public disclosure.

## Scope

The plugin intentionally executes Python code from the open notebook with the
user's privileges, so a malicious notebook is not a vulnerability by itself.
Examples of in-scope issues:

- bypassing session-workspace path containment;
- cross-session HTTP access or admission-fence bypass;
- HTML/script injection escaping the sanitizer;
- memory or CPU exhaustion reachable from untrusted notebooks beyond the
  documented limits;
- leaking data outside the workspace.

Out of scope: vulnerabilities in DSH, dsh-better-sidebar, Python, Jupyter or
other upstream projects (report those upstream), and issues already documented
in [CODE_REVIEW.md](CODE_REVIEW.md).

## Known Issues

[CODE_REVIEW.md](CODE_REVIEW.md) is a point-in-time audit snapshot; some findings
are still open. It is kept public for transparency and is not a substitute for a
coordinated disclosure.
