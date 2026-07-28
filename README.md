# Tilt

> **Fork disclaimer (`alleneubank/tilt`)**  
> This repository is a **fork** of [tilt-dev/tilt](https://github.com/tilt-dev/tilt).
> It carries performance work aimed at **canton-scale** localnets (heavy Compose/k8s
> log volume, ~170+ resources): daemon log-ingress backpressure and store clamps,
> plus HUD log-pane / resource-list virtualization (see [`web/SPEC.md`](web/SPEC.md)).
>
> **Many of these commits are not intended for upstream.** Commits that exist only
> for this fork use the subject prefix **`[fork]`** (packaging, overlay releases,
> this workflow). Upstreamable candidates keep normal conventional subjects and
> may still need re-shaping before a tilt-dev PR. Policy: [`AGENTS.md`](AGENTS.md).
>
> **Install / pin:** linux/amd64 fork releases are published as prerelease tags
> `v0.37.5-fork.<date>.g<sha>` (never GitHub “latest”). Consumers typically pin via
> [`tilt-overlay`](https://github.com/alleneubank/tilt-overlay). Current dogfood
> pin example: `0.37.5-fork.20260722.gb4791412e`.
>
> ### Benchmark results (hermetic HUD map, tilt-web-perf)
>
> Measured on release-equivalent builds with scrubbed canton-scale fixtures
> (`k3d` + log-only podmonitor replay). Metric: **raw long-task duration**
> (main-thread) unless noted. Floors and full map live in the sibling
> [tilt-web-perf](https://github.com/alleneubank/tilt-web-perf) harness.
>
> | Journey | Pre-M5 (red) | Post-M5 (shipped evidence) | Gate |
> | --- | ---: | ---: | ---: |
> | Cold-start raw long-task | **984 ms** | **428 / 426 ms** | ≤ 492 ms |
> | All-logs firehose raw long-task | **1556 ms** | **439 / 423 ms** | ≤ 778 ms |
> | Busy-resource retained heap slope | **15.27 MB/min** (absolute red) | **3.01 MB/min** | ≤ 5 MB/min |
>
> Additional product floors verified with the same program: log pane mounts at
> most **750** rendered lines with full history still reachable; return-to-tail
> after scrolling up (`e2e:log-pane`). Whole-HUD overview/sidebar mount bounds
> under ~176-resource scale are specified in `web/SPEC.md` (REQ-HUDPERF-*).
>
> Engine-side log pipeline work (store ingress clamp / backpressure) was
> validated on earlier hermetic soaks and monorepo localnet dogfood; the table
> above is the ratified **HUD** map-gate evidence for the virtualization pass.

<img src="assets/logo-wordmark.png" width="250">

[![Build Status](https://circleci.com/gh/tilt-dev/tilt/tree/master.svg?style=shield)](https://circleci.com/gh/tilt-dev/tilt)
[![GoDoc](https://godoc.org/github.com/tilt-dev/tilt?status.svg)](https://pkg.go.dev/github.com/tilt-dev/tilt)

Kubernetes for Prod, Tilt for Dev

Modern apps are made of too many services. They're everywhere and in constant
communication.

[Tilt](https://tilt.dev) powers microservice development and makes sure they behave!
Run `tilt up` to work in a complete dev environment configured for your team.

Tilt automates all the steps from a code change to a new process: watching
files, building container images, and bringing your environment
up-to-date. Think `docker build && kubectl apply` or `docker-compose up`.

## Watch: Tilt in Two Minutes

[![screencast](assets/tilt-video.png)](https://www.youtube.com/watch?v=FSMc3kQgd5Y)

## Install Tilt

Installing the `tilt` binary is a one-step command.

### macOS/Linux

```bash
curl -fsSL https://raw.githubusercontent.com/tilt-dev/tilt/master/scripts/install.sh | bash
```

### Windows

```powershell
iex ((new-object net.webclient).DownloadString('https://raw.githubusercontent.com/tilt-dev/tilt/master/scripts/install.ps1'))
```

For specific package managers (Homebrew, Scoop, Conda, asdf), see the
[Installation Guide](https://docs.tilt.dev/install.html).

## Run Tilt

**New to Tilt?** Our tutorial will [get you started](https://docs.tilt.dev/tutorial.html).

**Configuring a Service?** We have best practice guides for 
[HTML](https://docs.tilt.dev/example_static_html.html), 
[NodeJS](https://docs.tilt.dev/example_nodejs.html), 
[Python](https://docs.tilt.dev/example_python.html), 
[Go](https://docs.tilt.dev/example_go.html),
[Java](https://docs.tilt.dev/example_java.html),
and [C#](https://docs.tilt.dev/example_csharp.html).

**Optimizing a Tiltfile?** Search for the function you need in our 
[complete API reference](https://docs.tilt.dev/api.html).

## Community & Contributions

**Questions:** Join [the Kubernetes slack](http://slack.k8s.io) and
 find us in the [#tilt](https://kubernetes.slack.com/messages/CESBL84MV/)
 channel. Or [file an issue](https://github.com/tilt-dev/tilt/issues). For code snippets of Tiltfile functionality shared by the Tilt community, check out [Tilt Extensions](https://github.com/tilt-dev/tilt-extensions). 

**Contribute:** Check out our [guidelines](CONTRIBUTING.md) to contribute to Tilt's source code. To extend the capabilities of Tilt via new Tiltfile functionality, read more about [Extensions](https://docs.tilt.dev/extensions.html).

**Help us make Tilt even better:** Tilt sends anonymized usage data, so we can
improve Tilt on every platform. Details in ["What does Tilt
send?"](http://docs.tilt.dev/telemetry_faq.html).

We expect everyone in our community (users, contributors, followers, and employees alike) to abide by our [**Code of Conduct**](CODE_OF_CONDUCT.md).

## Reporting security issues

The maintainers take security seriously. If you discover a security issue,
please bring it to their attention right away!

Please **DO NOT** file a public issue, instead send your report privately to
[security@docker.com](mailto:security@docker.com).

Security reports are greatly appreciated and we will publicly thank you for it.
We also like to send gifts—if you're into Docker schwag, make sure to let
us know. We currently do not offer a paid security bounty program, but are not
ruling it out in the future.

## License

Copyright 2022 Docker, Inc.

Licensed under [the Apache License, Version 2.0](LICENSE)
