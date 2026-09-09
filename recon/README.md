# Bellhop Recon Observer (diagnostic)

Throwaway diagnostic tool, not part of the product. Not committed/maintained
long-term - delete when done discovering the API.

## Load unpacked

1. Open `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select this `recon/` directory

Logs appear in the DevTools console of each frame, prefixed
`[IDIRA-RECON]` (network calls) and `[IDIRA-FRAME]` (frame tree).
