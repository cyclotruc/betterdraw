// Your picture in Settings. An account clicks it to send a photo (cut to a 256 px square here, so the
// server only ever stores a small image) and can go back to the face drawn from the name. Guests see theirs.
import { useRef, useState } from "react";
import { api, type Me } from "./api";
import { avatarSrc } from "./avatar";
import { t } from "./texts";
import { toast } from "./toast";

const SIZE = 256;

async function square(file: File): Promise<Blob> {
  const img = await createImageBitmap(file);
  const side = Math.min(img.width, img.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  canvas.getContext("2d")!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  img.close();
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("encode"))), "image/webp", 0.86));
}

export function ProfilePhoto({ me, setMe }: { me: Me; setMe: (m: Me) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const img = <img className="avatar big" src={avatarSrc(me.name, me.image)} alt="" />;
  if (me.anonymous) return img;

  const send = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const blob = await square(file);
      const r = await fetch("/api/me/avatar", { method: "PUT", headers: { "content-type": blob.type }, body: blob });
      if (!r.ok) throw new Error(String(r.status));
      setMe({ ...me, image: (await r.json()).image });
    } catch {
      toast(t("photoFailed"));
    } finally {
      setBusy(false);
    }
  };
  const reset = () =>
    api<{ image: null }>("/api/me/avatar", { method: "DELETE" }).then(
      () => setMe({ ...me, image: null }),
      () => toast(t("err_generic")),
    );

  return (
    <div className={"photo" + (busy ? " busy" : "")}>
      <button
        type="button"
        className="photo-pick"
        onClick={() => input.current?.click()}
        title={t("changePhoto")}
        aria-label={t("changePhoto")}
      >
        {img}
        <span className="photo-edit" aria-hidden="true">
          {t("changePhotoShort")}
        </span>
      </button>
      {me.image && (
        <button type="button" className="photo-reset" onClick={reset} title={t("drawnFace")}>
          {t("drawnFaceShort")}
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        hidden
        onChange={(e) => {
          send(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
