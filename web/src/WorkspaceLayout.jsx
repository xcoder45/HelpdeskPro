import Footer from './Footer.jsx';

export default function WorkspaceLayout({ children }) {
  return (
    <div className="app-shell">
      {children}
      <Footer />
    </div>
  );
}
