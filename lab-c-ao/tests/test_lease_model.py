def lease(shard, worker, now, ttl):
    shard["attempts"] += 1
    shard.update(status="leased",worker=worker,expires=now+ttl,
                 token=f'r:{shard["id"]}:{shard["attempts"]}:{now+ttl}')
    return shard["token"]

def expire(shard, now):
    if shard["status"]=="leased" and now >= shard["expires"]:
        shard.update(status="ready",worker=None,expires=None,token=None)
        return True
    return False

def test_dead_worker_requeues_and_stale_result_is_invalid():
    s={"id":7,"status":"ready","attempts":0}
    old=lease(s,"A",1000,100)
    assert expire(s,1100)
    new=lease(s,"B",1100,100)
    assert old != new
    assert s["worker"]=="B"
    assert s["token"]==new

def test_unexpired_lease_survives():
    s={"id":1,"status":"ready","attempts":0}
    tok=lease(s,"A",1000,100)
    assert not expire(s,1099)
    assert s["token"]==tok
