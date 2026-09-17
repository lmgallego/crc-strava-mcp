import json, math, os
OUT="/mnt/user-data/outputs/fixtures"
os.makedirs(OUT,exist_ok=True)

def np_calc(power, time):
    # rolling 30 s mean over 1 Hz grid, full windows only, no bridging invalid gaps
    n=len(power); vals=[]
    for i in range(29,n):
        win_t=time[i-29:i+1]; win_p=power[i-29:i+1]
        if win_t[-1]-win_t[0]!=29: continue      # ventana atraviesa hueco
        if any(p is None for p in win_p): continue
        m=sum(win_p)/30.0; vals.append(m**4)
    if not vals: return None
    return (sum(vals)/len(vals))**0.25

def best(power,time,dur):
    n=len(power);b=None;st=None
    for i in range(dur-1,n):
        wt=time[i-dur+1:i+1];wp=power[i-dur+1:i+1]
        if wt[-1]-wt[0]!=dur-1: continue
        if any(p is None for p in wp): continue
        m=sum(wp)/dur
        if b is None or m>b: b=m;st=wt[0]
    return (round(b,2),st) if b is not None else (None,None)

def hr_for(p, base=95, gain=0.19, cap=178):
    return min(cap, round(base+gain*p))

def build(name, segs, ftp, kg, desc, gaps=None):
    """segs: lista de (duracion_s, watts) ; gaps: lista de (t_inicio, duracion) sin muestras"""
    time=[];power=[];hr=[];cad=[]
    t=0
    for dur,w in segs:
        for _ in range(dur):
            time.append(t);power.append(w)
            hr.append(hr_for(w));cad.append(0 if w==0 else 88)
            t+=1
    if gaps:
        keep=[]
        for i,tt in enumerate(time):
            drop=any(g0<=tt<g0+gd for g0,gd in gaps)
            if not drop: keep.append(i)
        time=[time[i] for i in keep];power=[power[i] for i in keep]
        hr=[hr[i] for i in keep];cad=[cad[i] for i in keep]
    npw=np_calc(power,time)
    avg=sum(power)/len(power)
    kj=sum(power)/1000.0
    exp={"fixture":name,"description":desc,
         "inputs":{"ftp_w":ftp,"weight_kg":kg},
         "expected":{
            "valid_seconds":len(power),
            "average_power_w":round(avg,2),
            "normalized_power_w":round(npw,2),
            "variability_index":round(npw/avg,4),
            "intensity_factor":round(npw/ftp,4),
            "tss":round(len(power)*npw*(npw/ftp)/(ftp*3600)*100,2),
            "work_kj":round(kj,2),
            "average_wkg":round(avg/kg,3),
            "power_curve":{}},
         "method":{"np":"media movil 30 s, ventanas completas, sin cruzar huecos no validos",
                   "tss_duration":"segundos validos",
                   "derivation":"calculado analiticamente sobre la serie sintetica"}}
    for d in (60,300,1200):
        b,st=best(power,time,d)
        if b is not None:
            exp["expected"]["power_curve"][str(d)]={"best_power_w":b,"best_power_wkg":round(b/kg,3),"start_time_s":st}
    streams={"activity_id":name,"synthetic":True,"device_watts":True,
             "streams":{"time":{"data":time},"watts":{"data":power},
                        "heartrate":{"data":hr},"cadence":{"data":cad}}}
    json.dump(streams,open(f"{OUT}/{name}.streams.json","w"))
    json.dump(exp,open(f"{OUT}/{name}.expected.json","w"),indent=2,ensure_ascii=False)
    print(name, "avg",round(avg,1),"NP",round(npw,1),"VI",round(npw/avg,3),"TSS",round(exp["expected"]["tss"],1))

FTP,KG=250,72.0
build("01-steady-endurance",[(3600,180)],FTP,KG,"60 min constantes a 180 W (Z2). NP=media, VI=1.0 por definicion.")
build("02-sweetspot",[(600,150),(720,225),(300,120),(720,225),(300,120),(720,225),(600,140)],FTP,KG,
      "Sesion sweet spot 3x12 min al 90% FTP con recuperaciones de 5 min.")
build("03-vo2max",[(900,165),(180,340),(180,120),(180,340),(180,120),(180,340),(180,120),(180,340),(180,120),(180,340),(600,140)],FTP,KG,
      "5x3 min al 136% FTP. El mejor 5 min NO puede ser 340 W: ningun tramo sostiene 300 s a esa potencia.")
build("04-paradas",[(1800,190),(1800,190),(1800,190)],FTP,KG,
      "Rodaje con dos paradas sin muestras (semaforo y cafe). Verifica que las ventanas moviles no cruzan huecos.",
      gaps=[(1800,45),(3600,600)])
build("05-descenso-ceros",[(1200,215),(600,0),(1200,200)],FTP,KG,
      "Subida, descenso de 10 min a 0 W en rueda libre y vuelta. Los ceros son dato real, no ausencia.")
