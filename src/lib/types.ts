export type NotifyFunction = (
  message: string,
  type?: "info" | "success" | "warning" | "error"
) => void;