import { splitProps, type JSX } from "solid-js";
import { cn } from "@/lib/utils";

/**
 * A numeric setting as a thin track and a small thumb.
 *
 * The native range thumb is an operating-system control. On WebKit it is
 * about twice the switch that sits in the same settings list, and
 * `accent-color` can recolour it but cannot shrink it. Dropping the native
 * drawing also drops the painted progress, so the filled part is a gradient
 * stopped at the current value.
 */
export function RangeField(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
  const [local, rest] = splitProps(props, ["class", "type", "min", "max", "value", "style"]);
  const percent = () => {
    const min = Number(local.min ?? 0);
    const max = Number(local.max ?? 100);
    const value = Number(local.value ?? min);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || !Number.isFinite(value)) return 0;
    return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
  };
  return (
    <input
      type="range"
      min={local.min}
      max={local.max}
      value={local.value}
      class={cn(
        "range-field h-6 min-w-0 flex-1 cursor-pointer appearance-none bg-transparent disabled:cursor-default disabled:opacity-40",
        local.class,
      )}
      style={{ "--range-percent": `${percent()}%`, ...(typeof local.style === "object" ? local.style : {}) }}
      {...rest}
    />
  );
}
