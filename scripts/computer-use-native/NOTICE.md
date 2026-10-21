# Mikiko Computer Use native backend

Built from https://github.com/iFurySt/open-computer-use at commit
43eb4b53de7a15b3f99ec2c9922bedeb95602266, MIT, Copyright (c) 2026 Leo.

Mikiko changes the permission identity, executable, configuration/socket names and
application discovery. The Mikiko backend disables visual cursor rendering and removes
the extracted reference artwork and source-directory image fallback. It also
disables global pointer fallback, sky input, virtual-display placement and Locked
Use integration. No Guardian, root broker or authorization plug-in is installed.

The adjacent upstream MIT license and THIRD-PARTY-NOTICES.md retain the Cua Driver
and yabai MIT notices and the statically linked libwebp BSD-3-Clause notice.
LICENSE.libwebp.txt in the built app is copied from the verified dependency.

Build provenance records the exact signature. Development uses a separate identity;
production distributions require Developer ID signing, hardened runtime and secure
timestamp, followed by notarization with the parent Mikiko App. Production adds a
single native control lease with verified idle-only upgrade/restart. Permission
diagnostics do not prove actual observation or input success.
