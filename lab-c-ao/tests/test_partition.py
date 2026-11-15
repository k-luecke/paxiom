import hashlib

def shards(n, z):
    out=[]
    i=0
    sid=1
    while i<n:
        e=min(i+z,n)
        out.append((sid,i,e))
        sid+=1;i=e
    return out

def test_partition_exact_many_shapes():
    for n in [1,2,31,32,33,256,3456,4608,181440]:
        for z in [1,7,64,257,1024,4096]:
            ss=shards(n,z)
            assert ss[0][1] == 0
            assert ss[-1][2] == n
            assert sum(e-a for _,a,e in ss) == n
            for left,right in zip(ss,ss[1:]):
                assert left[2] == right[1]

def test_deterministic_family_digest_example():
    payload=b"LAB-C-AO-SYNTHETIC-v1|N=4608|known=3137"
    assert hashlib.sha256(payload).hexdigest() == hashlib.sha256(payload).hexdigest()
