try {
  document.documentElement.dataset.theme =
    localStorage.getItem('helpdesk-theme') === 'dark' ? 'dark' : 'light';
} catch {
  document.documentElement.dataset.theme = 'light';
}
