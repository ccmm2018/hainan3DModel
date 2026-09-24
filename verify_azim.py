import math
W,H,TH=40.0,27.0,math.radians(30)
ca,sa=math.cos(TH),math.sin(TH)
def rot(x,y): return [x*ca-y*sa, x*sa+y*ca]
corners=[rot(0,0),rot(W,0),rot(W,H),rot(0,H)]
n=len(corners)
mx=sum(p[0] for p in corners)/n; my=sum(p[1] for p in corners)/n
cxx=sum((p[0]-mx)**2 for p in corners)/n
cyy=sum((p[1]-my)**2 for p in corners)/n
cxy=sum((p[0]-mx)*(p[1]-my) for p in corners)/n
phi=0.5*math.atan2(2*cxy, cxx-cyy)
print("PCA 主方向角 phi(deg)=",round(math.degrees(phi),2))
def align(p):
    dx,dy=p[0]-mx,p[1]-my; c,s=math.cos(-phi),math.sin(-phi)
    return [dx*c-dy*s, dx*s+dy*c]
aligned=[align(p) for p in corners]
X_SCALE=0.8; TILT=math.radians(10); DS=2.1; K=math.sin(TILT)*DS
def project(pts): return [[p[0]*X_SCALE, -p[1]*K] for p in pts]
proj=project(aligned)
def dot(a,b): return a[0]*b[0]+a[1]*b[1]
def angles(pts):
    res=[]
    for i in range(4):
        a=[pts[(i+1)%4][0]-pts[i][0], pts[(i+1)%4][1]-pts[i][1]]
        b=[pts[(i+2)%4][0]-pts[(i+1)%4][0], pts[(i+2)%4][1]-pts[(i+1)%4][1]]
        ang=math.degrees(math.acos(dot(a,b)/(math.hypot(*a)*math.hypot(*b))))
        res.append(round(ang,4))
    return res
print("转正+投影 四角:",[tuple(round(v,2) for v in p) for p in proj])
print("转正+投影 相邻边夹角(deg):",angles(proj),"  <- 全90°=矩形 OK")
proj_old=project(corners)
print("[对照] 未转正 四角:",[tuple(round(v,2) for v in p) for p in proj_old])
print("[对照] 未转正 相邻边夹角(deg):",angles(proj_old),"  <- 非90°=梯形/平行四边形")
