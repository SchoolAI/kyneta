type A = (() => string) & { a: number, b: string };
type B = Omit<A, "a">;
declare const b: B;
b();
