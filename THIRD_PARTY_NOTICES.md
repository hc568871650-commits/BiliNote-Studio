# Third-party components and sources

Studio source retains the upstream MIT license and copyright. This does not replace licenses of third-party components, icons, fonts, or user-provided media.

## Frontend

The source includes package.json, pnpm-lock.yaml and package-lock.json. License texts collected from the installed frontend dependency inventory are in docs/studio/THIRD_PARTY_NOTICES.frontend.txt and included with the Windows installer. The inventory is a superset including build-only dependencies, not a claim that every listed package is shipped. JSZip is used under its MIT option. Packages offering Apache-2.0 as an alternative use that option. MPL-only components retain their source availability through their exact package source distributions on the npm registry; package versions are recorded in the lockfiles.

## Python and desktop

Python runtime and dependency license texts are included with the installer under licenses. PyInstaller's bootloader exception applies to the frozen application; the exception and its license are retained. Rust dependencies are recorded in Cargo.lock and retain their respective licenses.

The initial installer does not distribute FFmpeg executables. Obtain FFmpeg separately from https://ffmpeg.org/download.html#build-windows and follow the license accompanying your chosen build. PyMuPDF / MuPDF and markdown_pdf are excluded; there is no built-in PDF export in this release.

## Assets

See UPSTREAM.md for provenance. Third-party brand icons do not imply endorsement. Demonstration screenshots are for illustrating the application; video content and tutorial excerpts are not relicensed under MIT.

Exact supplemental license texts and version-specific source URLs are in licenses/Extra/SOURCES.json and licenses/Extra/Rust/SOURCES.json. The excluded gmssl entry is provenance only, not a shipped dependency. For seahash 4.1.0, the original manifest identifies MIT and the authors; the standard MIT terms are explicitly labeled because the original author GitLab endpoint could not be retrieved. No copyright year was invented. MPL-covered selectors and other MPL crate sources can be obtained using the exact crate download URLs in those notices.
