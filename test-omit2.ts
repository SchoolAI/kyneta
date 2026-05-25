type A = (() => string) & { a: number, b: string };
type PreserveCall<T> = T extends (...args: infer A) => infer R ? (...args: A) => R : unknown;
type B = Omit<A, "a"> & PreserveCall<A>;
declare const b: B;
b();
