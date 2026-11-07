# Security Policy

## Reporting a Vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting:

<https://github.com/kexiongwen/dsh-bsb-ipynb/security/advisories/new>

Include the affected commit, DSH and dsh-better-sidebar versions, OS/Node/Python
versions, reproduction steps and the impact you expect. Reports are handled on a
best-effort basis; please allow time for a fix before public disclosure.

## Scope

The plugin intentionally executes notebook code with the user's privileges, so a
malicious notebook is not a vulnerability by itself. In scope: bypassing session
workspace containment, cross-session HTTP or admission-fence bypass, HTML/script
injection escaping the sanitizer, and resource exhaustion beyond the documented
limits. Vulnerabilities in DSH, dsh-better-sidebar, Python or Jupyter belong
upstream; known findings are tracked in [CODE_REVIEW.md](CODE_REVIEW.md).
