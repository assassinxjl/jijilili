#!/usr/bin/env python3
"""生成 geo-china.js：中国省界 + 地级市/区县边界 + 中心点（地球地图图层与地名搜索共用）。

数据来源：ECharts 4.9.0 自带的 map/json（china.json 省级、province/*.json 地级市）。
用法：
    npm pack echarts@4.9.0 && tar xzf echarts-4.9.0.tgz package/map/json
    python tools/build_china_geo.py package/map/json geo-china.js [省界简化容差(度) 市界简化容差(度)]

输出格式（window.JJLL_CN）：
    P: [[省名, 中心经度, 中心纬度, 边界编码], ...]
    C: [[市/区县名, 所属省, 中心经度, 中心纬度, 边界编码], ...]
边界编码：多个环用 ";" 分隔；每个环是 0.05° 量化后的「首点 + 逐点差分」整数序列，用 "," 分隔。
"""
import json,glob,os,math,sys
SRC=(sys.argv[1] if len(sys.argv)>1 else 'package/map/json').rstrip('/')+'/'
OUT=sys.argv[2] if len(sys.argv)>2 else 'geo-china.js'
def decode_poly(s,off,scale=1024):
    px,py=off; out=[]
    for i in range(0,len(s),2):
        x=ord(s[i])-64; y=ord(s[i+1])-64
        x=(x>>1)^(-(x&1)); y=(y>>1)^(-(y&1))
        px+=x; py+=y; out.append((px/scale,py/scale))
    return out
def rings_of(feat):
    g=feat['geometry']; co=g['coordinates']; offs=g.get('encodeOffsets')
    rings=[]
    if g['type']=='Polygon':
        for i,r in enumerate(co): rings.append(decode_poly(r,offs[i]) if isinstance(r,str) else r)
    else:
        for i,poly in enumerate(co):
            for j,r in enumerate(poly): rings.append(decode_poly(r,offs[i][j]) if isinstance(r,str) else r)
    return rings
def dp(pts,eps):
    if len(pts)<3: return pts
    keep=[False]*len(pts); keep[0]=keep[-1]=True; st=[(0,len(pts)-1)]
    while st:
        a,b=st.pop(); x1,y1=pts[a]; x2,y2=pts[b]; dx,dy=x2-x1,y2-y1; l=math.hypot(dx,dy) or 1e-9
        md=0;mi=-1
        for i in range(a+1,b):
            d=abs(dy*pts[i][0]-dx*pts[i][1]+x2*y1-y2*x1)/l
            if d>md: md=d;mi=i
        if md>eps: keep[mi]=True; st.append((a,mi)); st.append((mi,b))
    return [p for p,k in zip(pts,keep) if k]
def simp_ring(r,eps):
    # 闭合环：从最远点切成两段再简化
    if len(r)<8: return r
    m=max(range(1,len(r)),key=lambda i:(r[i][0]-r[0][0])**2+(r[i][1]-r[0][1])**2)
    a=dp(r[:m+1],eps); b=dp(r[m:],eps); return a+b[1:]
Q=20  # 0.05°
def enc(rings,eps,minext):
    parts=[]; n=0
    for r in rings:
        xs=[p[0] for p in r]; ys=[p[1] for p in r]
        if max(xs)-min(xs)<minext and max(ys)-min(ys)<minext: continue   # 丢掉很小的岛
        r=simp_ring(r,eps)
        pts=[];last=None
        for x,y in r:
            p=(round(x*Q),round(y*Q))
            if p==last: continue
            pts.append(p); last=p
        if len(pts)<4: continue
        a=[];px=py=0
        for i,(x,y) in enumerate(pts):
            a.append(x if i==0 else x-px); a.append(y if i==0 else y-py); px,py=x,y
        parts.append(','.join(map(str,a))); n+=len(pts)
    return ';'.join(parts),n
FILE2PROV={'anhui':'安徽','aomen':'澳门','beijing':'北京','chongqing':'重庆','fujian':'福建','gansu':'甘肃','guangdong':'广东','guangxi':'广西','guizhou':'贵州','hainan':'海南','hebei':'河北','heilongjiang':'黑龙江','henan':'河南','hubei':'湖北','hunan':'湖南','jiangsu':'江苏','jiangxi':'江西','jilin':'吉林','liaoning':'辽宁','neimenggu':'内蒙古','ningxia':'宁夏','qinghai':'青海','shandong':'山东','shanghai':'上海','shanxi':'山西','shanxi1':'陕西','sichuan':'四川','taiwan':'台湾','tianjin':'天津','xianggang':'香港','xinjiang':'新疆','xizang':'西藏','yunnan':'云南','zhejiang':'浙江'}
PE=float(sys.argv[3]) if len(sys.argv)>3 else 0.04
CE=float(sys.argv[4]) if len(sys.argv)>4 else 0.07
prov=json.load(open(SRC+'china.json',encoding='utf-8'))
P=[];tp=0
for f in prov['features']:
    e,n=enc(rings_of(f),PE,0.15); tp+=n
    P.append([f['properties']['name'],round(f['properties']['cp'][0],2),round(f['properties']['cp'][1],2),e])
C=[];tc=0
for fn,pname in FILE2PROV.items():
    d=json.load(open(SRC+'province/%s.json'%fn,encoding='utf-8'))
    for f in d['features']:
        nm=f['properties']['name']
        if '钓鱼岛' in nm: continue
        e,n=enc(rings_of(f),CE,0.12); tc+=n
        cp=f['properties'].get('cp')
        if not cp:   # 数据里缺中心点：取最大环的外包框中心
            big=max(rings_of(f),key=len); xs=[p[0] for p in big]; ys=[p[1] for p in big]
            cp=[(min(xs)+max(xs))/2,(min(ys)+max(ys))/2]; print('补中心点:',nm,[round(v,2) for v in cp])
        C.append([nm,pname,round(cp[0],2),round(cp[1],2),e])
print('省 点数',tp,'市 点数',tc,'省条目',len(P),'市条目',len(C))
js='window.JJLL_CN='+json.dumps({'P':P,'C':C},ensure_ascii=False,separators=(',',':'))+';\n'
open(OUT,'w',encoding='utf-8').write(js)
print('bytes',os.path.getsize(OUT))
