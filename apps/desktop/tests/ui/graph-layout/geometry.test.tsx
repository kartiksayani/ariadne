import { describe, expect, it } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Item } from '../../../src/generated/domain/models';
import { layoutGraph, selectedParentEdges } from '../../../src/graph/layout/geometry';
const item = (id: string, parent: string | null, ordinal: number, replacement: string | null = null): Item => ({ ...structuredClone(demo.items['1']), id, parent, ordinal, replaced_by: replacement }) as Item;

describe('canonical deterministic graph geometry', () => {
  it('places ordered leaves 94px apart, adds 32px between roots and centers parents between first and last children', () => {
    const input = [item('2',null,2), item('1.2.2','1.2',2), item('1.1','1',1), item('1',null,1), item('1.2','1',2), item('1.2.1','1.2',1)];
    const layout = layoutGraph(input), nodes = new Map(layout.nodes.map(node => [node.item.id,node]));
    expect(layout.nodes.map(node => node.item.id)).toEqual(['1','1.1','1.2','1.2.1','1.2.2','2']);
    expect(nodes.get('1.1')!.y).toBe(0); expect(nodes.get('1.2.1')!.y).toBe(94); expect(nodes.get('1.2.2')!.y).toBe(188);
    expect(nodes.get('1.2')!.y).toBe(141); expect(nodes.get('1')!.y).toBe(70.5); expect(nodes.get('2')!.y).toBe(314);
    expect(nodes.get('1.2.2')!.x).toBe(508); expect(layout.bounds).toEqual({x:0,y:0,width:698,height:380});
    expect(layoutGraph(input.slice().reverse())).toEqual(layout);
    expect(layout.nodes.every(node => node.width === 190 && node.height === 66)).toBe(true);
  });
  it('uses right-to-left cubic parent edges and only highlights actual selected ancestry', () => {
    const layout = layoutGraph([item('1',null,1),item('1.1','1',1),item('1.2','1',2)]);
    expect(layout.edges.find(edge => edge.target === '1.1')!.path).toBe('M 190 80 C 222 80, 222 33, 254 33');
    expect(selectedParentEdges(layout,'1.2')).toEqual(new Set(['parent:1:1.2']));
    expect(selectedParentEdges(layout,'missing')).toEqual(new Set());
  });
  it('keeps labelled replacement edges out of placement and parent cycle checks', () => {
    const input=[item('1',null,1,'2'),item('2',null,2,'1')],layout=layoutGraph(input);
    expect(layout.nodes).toEqual(layoutGraph(input.map(node=>({...node,replaced_by:null}))).nodes.map((node,index)=>({...node,item:input[index]})));
    expect(layout.edges.map(edge=>edge.kind)).toEqual(['replacement','replacement']);
    expect(layout.edges.every(edge=>edge.label !== null)).toBe(true);
    expect(selectedParentEdges(layout,'2').size).toBe(0);
    expect(layoutGraph([input[0]]).edges).toEqual([]);
  });
  it('rejects missing ancestor context, duplicate identities and parent cycles instead of manufacturing topology', () => {
    expect(()=>layoutGraph([item('1.1','1',1)])).toThrow('context');
    expect(()=>layoutGraph([item('1',null,1),item('1',null,1)])).toThrow('unique');
    expect(()=>layoutGraph([item('1','2',1),item('2','1',2)])).toThrow('cycle');
    expect(layoutGraph([])).toEqual({nodes:[],edges:[],bounds:{x:0,y:0,width:0,height:0}});
  });
});
