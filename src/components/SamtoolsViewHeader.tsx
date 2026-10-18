import { useEffect, useRef, useState } from "react";
import Aioli from "@biowasm/aioli";
import "./SamtoolsViewHeader.css";

type SamtoolsViewHeaderProps = {
  file: File | null;
};

type Status =
  | "idle"
  | "loading"
  | "running"
  | "success"
  | "error";

type CommandResult =
  | string
  | {
      stdout: string;
      stderr: string;
    };

let samtoolsPromise: Promise<Aioli> | null = null;

function getSamtools(): Promise<Aioli> {
  if (!samtoolsPromise) {
    samtoolsPromise = new Aioli(
      ["samtools/1.21"],
      {
        printInterleaved: false,
        debug: false,
      },
    );
  }

  return samtoolsPromise;
}

export default function SamtoolsViewHeader({
  file,
}: SamtoolsViewHeaderProps) {
  const runIdRef = useRef(0);

  const [status, setStatus] =
    useState<Status>("idle");

  const [header, setHeader] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!file) {
      setStatus("idle");
      setHeader("");
      setError("");
      return;
    }

    const runId = ++runIdRef.current;

    async function readHeader() {
      try {
        setStatus("loading");
        setHeader("");
        setError("");

        const samtools = await getSamtools();

        if (runId !== runIdRef.current) {
          return;
        }

        setStatus("running");

        const mountedPaths = await samtools.mount([file]);
        const mountedPath = mountedPaths[0];

        const result = (await samtools.exec(
          "samtools",
          [
            "head",
            "-n",
            "100",
            mountedPath,
          ],
        )) as CommandResult;

        if (runId !== runIdRef.current) {
          return;
        }

        const stdout =
          typeof result === "string"
            ? result
            : result.stdout;

        const stderr =
          typeof result === "string"
            ? ""
            : result.stderr;

        if (!stdout && stderr) {
          throw new Error(stderr);
        }

        setHeader(stdout);
        setStatus("success");
      } catch (caughtError) {
        if (runId !== runIdRef.current) {
          return;
        }

        setHeader("");

        setError(
          caughtError instanceof Error
            ? caughtError.message
            : String(caughtError),
        );

        setStatus("error");
      }
    }

    void readHeader();
  }, [file]);

  return (
    <section
      className="samtools-header"
      aria-live="polite"
    >
      <div className="samtools-header__heading">
        <div>
          <h2>SAMtools header</h2>

          {file && (
            <p className="samtools-header__filename">
              {file.name}
            </p>
          )}
        </div>

        {(status === "loading" ||
          status === "running") && (
          <span className="samtools-header__badge">
            {status === "loading"
              ? "Loading SAMtools"
              : "Reading header"}
          </span>
        )}
      </div>

      {status === "idle" && (
        <p className="samtools-header__empty">
          Select a SAM, BAM, or CRAM file to display
          its header.
        </p>
      )}

      {status === "error" && (
        <div
          className="samtools-header__error"
          role="alert"
        >
          <strong>Could not read the header</strong>
          <pre>{error}</pre>
        </div>
      )}

      {status === "success" && (
        <pre className="samtools-header__output">
          {header ||
            "The file did not contain a SAM header."}
        </pre>
      )}
    </section>
  );
}