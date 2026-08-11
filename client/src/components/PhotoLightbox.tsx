import { useState, useEffect, useCallback } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

interface PhotoLightboxProps {
  photos: { src: string; label: string }[];
  initialIndex?: number;
  onClose: () => void;
}

export default function PhotoLightbox({ photos, initialIndex = 0, onClose }: PhotoLightboxProps) {
  const { t } = useTranslation("common");
  const [index, setIndex] = useState(initialIndex);

  const prev = useCallback(() => setIndex((i) => (i > 0 ? i - 1 : photos.length - 1)), [photos.length]);
  const next = useCallback(() => setIndex((i) => (i < photos.length - 1 ? i + 1 : 0)), [photos.length]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, prev, next]);

  if (photos.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center" onClick={onClose}>
      <div className="relative w-full h-full flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
        {/* Close button */}
        <button onClick={onClose} className="absolute top-4 right-4 text-white/80 hover:text-white z-10" aria-label={t("lightbox.close")}>
          <X size={28} />
        </button>

        {/* Photo counter */}
        <div className="absolute top-4 left-4 text-white/80 text-sm">
          {index + 1} / {photos.length}
        </div>

        {/* Label */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-white/80 text-sm font-medium bg-black/50 px-4 py-1 rounded-full">
          {photos[index].label}
        </div>

        {/* Navigation arrows */}
        {photos.length > 1 && (
          <>
            <button onClick={prev} className="absolute left-4 text-white/70 hover:text-white p-2" aria-label={t("lightbox.previous")}>
              <ChevronLeft size={36} />
            </button>
            <button onClick={next} className="absolute right-4 text-white/70 hover:text-white p-2" aria-label={t("lightbox.next")}>
              <ChevronRight size={36} />
            </button>
          </>
        )}

        {/* Image */}
        <img
          src={photos[index].src}
          alt={photos[index].label}
          className="max-w-full max-h-[85vh] object-contain rounded-lg"
        />
      </div>
    </div>
  );
}
