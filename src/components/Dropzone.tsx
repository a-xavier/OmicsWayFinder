import { useRef, useState } from "react";
import "./Dropzone.css";

export type DropzoneProps = {
  onFilesSelected: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
};

export default function Dropzone({
  onFilesSelected,
  accept,
  multiple = true,
  disabled = false,
}: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

  function selectFiles(files: FileList | null) {
    if (!files || disabled) return;

    const nextFiles = Array.from(files);
    setSelectedFiles(nextFiles);
    onFilesSelected(nextFiles);
  }

  function openFileDialog() {
    if (!disabled) inputRef.current?.click();
  }

  function handleDragEnter(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current -= 1;

    if (dragDepth.current === 0) {
      setIsDragging(false);
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    selectFiles(event.dataTransfer.files);
  }

  return (
    <div className="dropzone-wrapper">
      <div
        className={`dropzone ${isDragging ? "dropzone--dragging" : ""} ${
          disabled ? "dropzone--disabled" : ""
        }`}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={openFileDialog}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openFileDialog();
          }
        }}
        onDragEnter={handleDragEnter}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={inputRef}
          className="dropzone__input"
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          onChange={(event) => {
            selectFiles(event.target.files);
            event.target.value = "";
          }}
        />

        <div className="dropzone__icon" aria-hidden="true">
          ↑
        </div>

        <p className="dropzone__title">
          {isDragging ? "Release files here" : "Drop files here"}
        </p>
        <p className="dropzone__hint">or click to choose files</p>
        {accept && <p className="dropzone__formats">Accepted: {accept}</p>}
      </div>

      {selectedFiles.length > 0 && (
        <div className="selected-files" aria-live="polite">
          <h3>Selected files</h3>
          <ul>
            {selectedFiles.map((file) => (
              <li key={`${file.name}-${file.lastModified}`}>
                <span>{file.name}</span>
                <span>{formatFileSize(file.size)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function formatFileSize(bytes: number) {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / 1024 ** unitIndex;

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${
    units[unitIndex]
  }`;
}