# Services run as their image's user with a fixed entrypoint cap set

A Service (a database or cache a sandboxed run's tests use) runs in its own container on the run's
internal network. Unlike the agent's container it keeps its image's own user and gets back a fixed
set of capabilities — CHOWN, SETUID, SETGID, DAC_OVERRIDE, FOWNER — after `--cap-drop ALL`. The set
is not configurable.

## Why

- Official database images (postgres, mysql) start as root, chown their data dir, then drop to their
  own user. Under the agent's policy (`--cap-drop ALL`, `--user <host uid>`) they fail to start, and
  asking users to find rootless-friendly images defeats the point of the feature.
- Mapping the host uid protects files written to host mounts. A Service has no host mounts, no
  published ports and no egress, so the uid it runs as reaches nothing of the host.
- A fixed set keeps the policy auditable: no per-profile knob a ticket author could talk an
  operator into widening. A service that needs more than this set is not supported.

## Consequences

- A Service container is deliberately less locked down than the agent's; reviews must not "fix" it to
  match without breaking official images.
- Widening the set later is an additive change; narrowing it would break configured services.
