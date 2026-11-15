"""Run a wasip1 build under wasmtime with fuel metering and report the
fuel consumed (executed wasm operators; see ../README.md for what fuel
counts), split by the harness's phase marks when the module imports
ops.mark.

    python run.py <module.wasm> <dir to preopen as /p> [args...]

Prints the program's stdout, then one line per phase and a TOTAL.
"""

import sys
import tempfile

import wasmtime

FUEL = 1 << 62


def main() -> None:
    wasm, root, *args = sys.argv[1:]
    cfg = wasmtime.Config()
    cfg.consume_fuel = True
    engine = wasmtime.Engine(cfg)
    module = wasmtime.Module.from_file(engine, wasm)
    store = wasmtime.Store(engine)
    store.set_fuel(FUEL)

    out = tempfile.NamedTemporaryFile(delete=False)
    out.close()
    wasi = wasmtime.WasiConfig()
    wasi.argv = ["tsgo", *args]
    wasi.env = [("OPS_LIB_DIR", "/p")]
    wasi.preopen_dir(root, "/p")
    wasi.stdout_file = out.name
    wasi.inherit_stderr()
    store.set_wasi(wasi)

    linker = wasmtime.Linker(engine)
    linker.define_wasi()

    phases: list[tuple[str, int]] = [("start", 0)]
    memory: list[wasmtime.Memory] = []

    def mark(ptr: int, n: int) -> None:
        name = bytes(memory[0].read(store, ptr, ptr + n)).decode()
        phases.append((name, FUEL - store.get_fuel()))

    if any(i.module == "ops" for i in module.imports):
        linker.define_func("ops", "mark", wasmtime.FuncType([wasmtime.ValType.i32(), wasmtime.ValType.i32()], []), mark)

    inst = linker.instantiate(store, module)
    memory.append(inst.exports(store)["memory"])
    code = 0
    try:
        inst.exports(store)["_start"](store)
    except wasmtime.ExitTrap as e:
        code = e.code
    used = FUEL - store.get_fuel()
    phases.append(("exit", used))

    sys.stdout.write(open(out.name).read())
    print(f"exit {code}")
    totals: dict[str, int] = {}
    order: list[str] = []
    for (name, at), (_, nxt) in zip(phases, phases[1:]):
        if name not in totals:
            totals[name] = 0
            order.append(name)
        totals[name] += nxt - at
    for name in order:
        print(f"  {name:28} {totals[name]:14}")
    print(f"  {'TOTAL':28} {used:14}")


if __name__ == "__main__":
    main()
