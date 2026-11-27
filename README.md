# ExamPasser

> A minimalist cross-browser extension for analyzing the visible area of your screen with the Gemini API.

ExamPasser captures the current tab manually or on a schedule, sends the screenshot to Gemini, and displays a compact answer in the bottom-right corner of the page.

**Languages:** [English](README.md) · [Українська](README.uk.md) · [Русский](README.ru.md)

## Features

- Manifest V3.
- Supports Chrome, Opera/Opera GX, Firefox, and Zen Browser.
- Visible-area screenshot analysis.
- Manual hotkey mode.
- Automatic capture mode with an interval starting at 20 seconds.
- Compact overlay isolated with a closed Shadow DOM.
- Ukrainian, Russian, and English interface.
- Fast `gemini-3.5-flash-lite` model.
- Adjustable answer opacity.
- API key and settings stored locally in the browser.

## Get a Gemini API key

1. Open [Google AI Studio](https://aistudio.google.com/apikey).
2. Sign in with your Google account.
3. Click **Create API key**.
4. Copy the key and paste it into ExamPasser.
5. Click **Save settings**.

Never publish or share your API key. Each user should use their own key.

## Install on Chrome or Opera GX

For a ready-made package, open the [Releases](https://github.com/AGraves2347/ExamPasser/releases) page and download:

- `ExamPasser-Chrome.zip` for Chrome;
- `ExamPasser-Opera.zip` for Opera GX.

To install an unpacked version:

1. Download or clone this repository.
2. Copy `manifest.chrome.json` to a new folder as `manifest.json` for Chrome, or copy `manifest.opera.json` as `manifest.json` for Opera GX.
3. Open `chrome://extensions` in Chrome or `opera://extensions` in Opera GX.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select the prepared folder.
6. Pin ExamPasser to the browser toolbar.

Keep the selected folder in place because the browser loads the extension directly from it.

## Install on Firefox or Zen Browser

For a ready-made package, download `File for quick download FireFox.xpi` from the [Releases](https://github.com/AGraves2347/ExamPasser/releases) page. This file is already signed by Mozilla and can be installed directly in Firefox or Zen Browser. `ExamPasser-Firefox.zip` contains the unpacked source package for development.

1. Open `about:addons`.
2. Select the gear menu → **Install Add-on From File**.
3. Choose `File for quick download FireFox.xpi`.

## Controls

- Default command: `Alt+Q`.
- Alternative command: `Alt+Shift+Q`.
- Self-uninstall command: `Alt+Shift+K` without an additional confirmation.
- Custom shortcuts can be configured from the extension menu or browser settings.
- Manual mode starts an analysis with a hotkey.
- Automatic mode starts analyses at the selected interval.

## Project structure

- `manifest.json` — Chrome manifest.
- `manifest.opera.json` — Opera manifest.
- `manifest.firefox.json` — Firefox/Zen Browser manifest.
- `background.js` — background logic, screenshots, scheduling, and Gemini requests.
- `content.js` — isolated answer overlay.
- `popup.html` — settings UI.
- `popup.js` — settings logic, localization, and persistence.
- `icon.svg` — extension icon.

## Privacy

Screenshots are sent to the Google Gemini API only when an analysis is started. ExamPasser has no own server. The API key, language, work mode, and other settings are stored in the browser's local storage.

## License

ExamPasser is distributed under the [ExamPasser Personal Use License](LICENSE.md).

Personal, non-commercial use of the unmodified extension is allowed. Copying, modifying, redistributing, selling, or publishing the extension requires prior written permission from the copyright holder.
