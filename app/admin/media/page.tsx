"use client";

import { FormEvent, useState } from "react";

export default function AdminMediaPage() {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setStatus("Uploading...");

    const formElement = event.currentTarget;
    const formData = new FormData(formElement);
    const adminKey = String(formData.get("adminKey") ?? "");
    formData.delete("adminKey");

    try {
      const response = await fetch("/api/admin/media", {
        method: "POST",
        headers: { "x-admin-key": adminKey },
        body: formData,
      });

      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Upload failed");
      setStatus(`Uploaded: ${body.storagePath}`);
      formElement.reset();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="adminShell">
      <div className="adminPanel">
        <div className="breadcrumbs">Kpoparkive › Admin › Media</div>
        <h1>Media uploader</h1>
        <p className="adminIntro">
          Upload images directly to the Supabase <strong>wiki-media</strong> bucket and register them in the media table.
        </p>

        <form className="adminForm" onSubmit={submit}>
          <label>
            Admin key
            <input name="adminKey" type="password" autoComplete="off" required />
          </label>

          <label>
            Document slug
            <input name="documentSlug" placeholder="rescene" defaultValue="rescene" required />
          </label>

          <label>
            Role
            <select name="role" defaultValue="infobox">
              <option value="infobox">Infobox / main image</option>
              <option value="logo">Logo</option>
              <option value="profile-history">Profile history</option>
              <option value="member:woni">Member · Woni</option>
              <option value="member:liv">Member · Liv</option>
              <option value="member:minami">Member · Minami</option>
              <option value="member:may">Member · May</option>
              <option value="member:zena">Member · Zena</option>
              <option value="album-cover">Album cover</option>
              <option value="activity">Activity</option>
            </select>
          </label>

          <label>
            Image
            <input name="file" type="file" accept="image/jpeg,image/png,image/webp,image/avif,image/gif" required />
          </label>

          <label>
            Alt text
            <input name="altText" placeholder="RESCENE group photo" />
          </label>

          <label>
            Caption
            <input name="caption" placeholder="Optional caption" />
          </label>

          <label>
            Source credit
            <input name="sourceCredit" placeholder="Official account / photographer / source note" />
          </label>

          <button type="submit" disabled={busy}>{busy ? "Uploading..." : "Upload to Supabase"}</button>
        </form>

        {status && <pre className="adminStatus">{status}</pre>}
      </div>
    </main>
  );
}
