import { useState } from 'react';
import { ErrorBanner, Pagination } from './ui.jsx';

const EMPTY_FORM = { name: '', description: '' };

export default function CategoriesPanel({
  categories,
  pagination,
  loading,
  busy,
  error,
  onCreate,
  onUpdate,
  onToggle,
  onCreateSubcategory,
  onToggleSubcategory,
  onPageChange,
  onRefresh
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [subcategoryDrafts, setSubcategoryDrafts] = useState({});
  const [editing, setEditing] = useState(null);

  function updateForm(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submitCreate(event) {
    event.preventDefault();
    const created = await onCreate(form);
    if (created) setForm(EMPTY_FORM);
  }

  async function submitEdit(event, category) {
    event.preventDefault();
    const updated = await onUpdate(category.id, form);
    if (updated) setEditing(null);
  }

  return (
    <section className="staff-users" aria-busy={loading}>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Administration</span>
          <h1>Categories</h1>
          <p className="muted">Manage the service catalog used when employees submit tickets.</p>
        </div>
        <button type="button" className="button button-secondary" onClick={onRefresh} disabled={loading}>
          Refresh
        </button>
      </div>

      <ErrorBanner message={error} />

      <div className="staff-users-grid">
        <article className="panel">
          <h2>{editing ? 'Edit category' : 'New category'}</h2>
          <form
            onSubmit={editing ? (event) => submitEdit(event, editing) : submitCreate}
            className="form-stack"
          >
            <label htmlFor="category-name">Name</label>
            <input
              id="category-name"
              value={form.name}
              onChange={(event) => updateForm('name', event.target.value)}
              minLength={2}
              maxLength={100}
              required
            />
            <label htmlFor="category-description">Description</label>
            <textarea
              id="category-description"
              value={form.description}
              onChange={(event) => updateForm('description', event.target.value)}
              maxLength={500}
              rows={3}
            />
            <div className="inline-actions">
              <button type="submit" className="button button-primary" disabled={busy}>
                {editing ? 'Save category' : 'Create category'}
              </button>
              {editing && (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => { setEditing(null); setForm(EMPTY_FORM); }}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </article>

        <article className="panel">
          <h2>Catalog</h2>
          {loading ? (
            <p className="muted">Loading categories…</p>
          ) : categories.length === 0 ? (
            <p className="empty-state">No categories found.</p>
          ) : (
            <div className="catalog-list">
              {categories.map((category) => (
                <div key={category.id} className="catalog-item">
                  <div className="catalog-item-header">
                    <div>
                      <strong>{category.name}</strong>
                      {!category.isActive && <span className="status-badge badge-unknown">Inactive</span>}
                      <p className="muted">{category.description || 'No description'}</p>
                    </div>
                    <div className="inline-actions">
                      <button
                        type="button"
                        className="button button-link"
                        disabled={busy}
                        onClick={() => {
                          setEditing(category);
                          setForm({ name: category.name, description: category.description ?? '' });
                        }}
                      >
                        Edit
                      </button>
                      <button type="button" className="button button-link" disabled={busy} onClick={() => onToggle(category)}>
                        {category.isActive ? 'Disable' : 'Enable'}
                      </button>
                    </div>
                  </div>
                  <ul className="subcategory-list">
                    {category.subcategories.map((subcategory) => (
                      <li key={subcategory.id}>
                        <span>{subcategory.name}</span>
                        {!subcategory.isActive && <span className="status-badge badge-unknown">Inactive</span>}
                        <button
                          type="button"
                          className="button button-link"
                          disabled={busy}
                          onClick={() => onToggleSubcategory(category, subcategory)}
                        >
                          {subcategory.isActive ? 'Disable' : 'Enable'}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <form
                    className="inline-actions"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const name = (subcategoryDrafts[category.id] ?? '').trim();
                      if (!name) return;
                      const created = await onCreateSubcategory(category.id, name);
                      if (created) {
                        setSubcategoryDrafts((current) => ({ ...current, [category.id]: '' }));
                      }
                    }}
                  >
                    <label className="sr-only" htmlFor={`subcategory-${category.id}`}>
                      New subcategory for {category.name}
                    </label>
                    <input
                      id={`subcategory-${category.id}`}
                      value={subcategoryDrafts[category.id] ?? ''}
                      onChange={(event) => setSubcategoryDrafts((current) => ({
                        ...current,
                        [category.id]: event.target.value
                      }))}
                      placeholder="New subcategory"
                      minLength={2}
                      maxLength={100}
                    />
                    <button type="submit" className="button button-secondary" disabled={busy}>Add</button>
                  </form>
                </div>
              ))}
            </div>
          )}
          <Pagination
            pagination={pagination}
            ariaLabel="Category pages"
            itemLabel="categories"
            onPageChange={onPageChange}
          />
        </article>
      </div>
    </section>
  );
}
