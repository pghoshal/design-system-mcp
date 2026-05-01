export class AtomicRef<T> {
  #value: T;

  constructor(initial: T) {
    this.#value = initial;
  }

  get(): T {
    return this.#value;
  }

  swap(next: T): T {
    const prev = this.#value;
    this.#value = next;
    return prev;
  }
}
