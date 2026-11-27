export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="app-footer">
      <p>© {year} Helpdesk Pro. All rights reserved. Built by xcoder45.</p>
    </footer>
  );
}
