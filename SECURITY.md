# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Report it
privately through GitHub's
[private vulnerability reporting](https://github.com/hochgi/test-kit/security/advisories/new)
for this repository.

Include the affected package and version, what an attacker can do, and a
reproduction if you have one. You should get an acknowledgement within a week.

## Scope

These packages are test-time libraries: they fake infrastructure inside a test
process and are meant to be installed as dev dependencies. Reports are most
useful when they affect that use, for example a published tarball that runs
unexpected code on install or a dependency with a known exploitable issue.

## Supported versions

Only the latest published major of each package receives fixes.
