# Reproduction of cost 3 with the lua-in-types runtime (read-only, ../lua-in-types/src/aot/types).
# Copied from lua-in-types-wt/aot-emit2/.run/shp/gen.py; added opkind 'storef' (Store<...> extends infer h).
# usage: python3 -I lua_repro.py FILL OPS OUT.ts OPKIND VAL   (env V=iface: interface shapes)
import random,sys
def lsf(v):
    h=format(v,'x')[::-1]
    if int(h[-1],16)>=8: h+="0"
    return h
import os
def gen(fill, ops, fname, nimg=5000, seed=3, opkind='full', val='load'):
    wrap=os.environ.get('WRAP','')
    random.seed(seed)
    L=['type C10<V> = ' + ''.join('TSetS<' for _ in range(10)) + 'TNew' + ''.join(f', "sk{k}", [V]>' for k in range(10)) + ';',
       'type C40<V> = ' + ''.join('TSetS<' for _ in range(40)) + 'TNew' + ''.join(f', "sk{k}", [V]>' for k in range(40)) + ';',
       'type CA<V> = ' + ''.join('TSet<' for _ in range(8)) + 'TNew' + ''.join(f', "i{k+1}", [V]>' for k in range(8)) + ';',
       'type E1x = [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined];', 'type SH<T> = { [K in keyof T]: T[K] };', 'import type { HStatic, Store, Load, TStatic, TGetS, TSetS, TNew, TSet, TSetMeta } from "/Users/gabrielperez/Documents/lua-in-types/src/aot/types/table.ts";','import type { Empty, ASet, AGet } from "/Users/gabrielperez/Documents/lua-in-types/src/aot/types/trie.ts";']
    objs=[]
    V=os.environ.get('V','')
    ifaces=[]
    for i in range(nimg):
        shape=f'{{ "sa": "0"; "sb": "1"; "sc{i%37}": "2" }}'
        if wrap: shape=f'{wrap}<{shape}>'
        if 'iface' in V:
            ifaces.append(f'interface Sh{i%37} {shape}')
            shape=f'Sh{i%37}'
        ts = 'TSt' if 'tst' in V else 'TStatic'
        arr = 'ArrE1' if 'arr' in V else '["1", Empty["1"]]'
        sbv = f'F{i%50}' if 'clos' in V else f'"x{i}"'
        objs.append(f'"{lsf(i)}": {ts}<"0", {arr}, {shape}, "3", ["1", [["sa", ["{lsf(i)}"]], ["sb", {sbv}], ["sc{i%37}", ["T", "{lsf((i*13)%nimg)}"]], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]]>')
        continue
        objs.append(f'"{lsf(i)}": TStatic<"0", ["1", Empty["1"]], {shape}, "3", ["1", [["sa", ["{lsf(i)}"]], ["sb", "x{i}"], ["sc{i%37}", ["T", "{lsf((i*13)%nimg)}"]], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]]>')
    L.extend(dict.fromkeys(ifaces))
    for k in range(50): L.append(f'type F{k} = ["F", "{lsf(k+9000)}", "{k}", [["C", "{lsf(k)}"], F{(k+1)%50}]];' if 'cyc' in V else f'type F{k} = ["F", "{lsf(k+9000)}", "{k}", [["C", "{lsf(k)}"]]];')
    L.append('type TSt<N, A, X, C, S> = N extends unknown ? [N, A, "s", X, "0", C, S, undefined] : never;')
    L.append('type MkA<D, R> = D extends unknown ? [D, R] : never; type ArrE1 = MkA<"1", Empty["1"]>;')
    L.append(f'type H0 = HStatic<"{lsf(nimg)}", {{ {"; ".join(objs)} }}, "4">;')
    ids=random.sample(range(nimg), fill)
    for i,v in enumerate(ids):
        o = {'load': f'Load<H0, "{lsf(v)}">', 'new': 'TNew', 'small': f'["v{i}"]',
             'obj': f'["v{i}", {{ a: "{i}" }}]', 'objc': f'["v{i}", {{ a: "x" }}]',
             'empty': f'["v{i}", Empty["1"]]', 'nest': f'["v{i}", ["w", ["x{i}"]]]',
             'tnewv': f'TSetS<TNew, "sa", ["{i}"]>',
             'tup16': '["v%d", [%s]]' % (i, ", ".join('"a%d"' % k for k in range(16))),
             'tup16u': '["v%d", [%s]]' % (i, ", ".join('undefined' for k in range(16))),
             'tup16i': '["v%d", [%s]]' % (i, ", ".join('"a%d"' % (k+i) for k in range(16))),
             'e1': 'E1x', 'e1v': '["v%d", E1x]' % i,
             'chain10': 'C10<"%d">' % i, 'dict40': 'C40<"%d">' % i, 'arr': 'CA<"%d">' % i, 'meta': 'TSetMeta<TNew, ["T", "%s"]>' % lsf(i),
             }[val]
        L.append(f'type Y{i+1} = Store<{"H0" if i==0 else "Y"+str(i)}, "{lsf(v)}", {o}>;')
    L.append(f'type HF = {"Y"+str(fill) if fill else "H0"};')
    L.append('export const fillf: 0 = null! as HF["h"][0];')
    L.append('type Z0 = HF;')
    hot=random.sample(range(nimg), 40)
    for j in range(ops):
        a=lsf(hot[j%40]); b=lsf(hot[(j*7+1)%40])
        if opkind=='full':
            L.append(f'type Z{j+1} = Store<Z{j}, "{a}", TSetS<Load<Z{j}, "{a}">, "sa", TGetS<Load<Z{j}, "{b}">, "sb">>>;')
        elif opkind=='store':
            L.append(f'type Z{j+1} = Store<Z{j}, "{a}", ["w{j}"]>;')
        elif opkind=='storef':
            L.append(f'type Z{j+1} = Store<Z{j}, "{a}", ["w{j}"]> extends infer h ? h : never;')
        elif opkind=='load':
            L.append(f'type Z{j+1} = [Z{j}, Load<Z0, "{a}">][0]; type Q{j+1} = Load<Z0, "{lsf(hot[(j*3)%40])}">;')
    if ops: L.append(f'export const opsf: 0 = null! as Z{ops}["h"][0];')
    open(fname,'w').write("\n".join(L)+"\n")
if __name__=='__main__':
    fill,ops,fname,opkind,val=int(sys.argv[1]),int(sys.argv[2]),sys.argv[3],sys.argv[4],sys.argv[5]
    gen(fill,ops,fname,opkind=opkind,val=val)
