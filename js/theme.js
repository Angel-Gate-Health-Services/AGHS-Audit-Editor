// Runs before styles load. The interactive app must never run inside another page.
if (window.self !== window.top) document.documentElement.hidden = true;
try {
  const mode = localStorage.getItem('aghs-theme');
  if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-color-mode', mode);
} catch {
  // System theme remains available when browser storage is blocked.
}
